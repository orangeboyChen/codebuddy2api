/**
 * CodeBuddy's own fetch backend, at `{endpoint}/agenttool/v1/webfetch`.
 *
 * Same reasoning as the native search backend: it is the endpoint the CLI
 * calls, so it needs no extra deployment and authenticates with the credential
 * already held by the gateway. It also returns extracted, markdown-ish text
 * rather than raw HTML, which is usually a better prompt than a local fetch
 * can produce.
 *
 * A credential is required — the endpoint rejects the call without a bearer
 * token, so the backend surfaces that instead of issuing a doomed request.
 *
 * The endpoint is raced against a local fetch, exactly as the CLI does. That
 * fallback is the whole reason a deployment gets data back when the endpoint is
 * slow, unauthenticated, or not deployed at all: the CLI's own
 * `fetchWithFallback` starts both and keeps whichever finishes, preferring the
 * extracted text from the endpoint but settling for the local copy. Without it,
 * a single failed call is a failed tool result and the model sees nothing.
 */

import { formatFetchResult } from '../shared';
import { createLocalFetchProvider, type HostResolver } from './local-fetch';
import type { EndpointResolver, TokenResolver } from '../token';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
} from '../types';

const FETCH_PATH = '/agenttool/v1/webfetch';
/** The CLI waits 20s for the endpoint and 30s for its own local fetch. */
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;

/**
 * Normalizes a URL the way the CLI does before handing it to the endpoint.
 *
 * Two rewrites, matching `normalizeWebFetchUrl` in the CodeBuddy CLI:
 *
 * - `http://` becomes `https://`. Plain HTTP is almost never what a model meant,
 *   and upgrading is what the CLI has always done.
 * - A GitHub `blob/` URL becomes its `raw.githubusercontent.com` equivalent, so
 *   the fetch returns file contents instead of the surrounding HTML viewer. This
 *   is the commonest case where the URL a model supplies is the wrong document.
 */
export const normalizeFetchUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim();
  const isGithubBlob =
    trimmed.includes('github.com') && trimmed.includes('/blob/');

  const upgraded = trimmed.startsWith('http://')
    ? `https://${trimmed.slice('http://'.length)}`
    : trimmed;

  if (!isGithubBlob) {
    return upgraded;
  }

  return upgraded
    .replace('github.com', 'raw.githubusercontent.com')
    .replace('/blob/', '/');
};

/**
 * Binary content types the CLI refuses to read as text.
 *
 * The list is the CLI's own: archives, office documents, and octet-streams. Any
 * of these would be decoded as a binary string and poured into the transcript,
 * which is both useless and expensive, so they are refused.
 */
const BINARY_CONTENT_TYPES = new Set([
  'application/gzip',
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-gzip',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/zip',
]);

/**
 * Mirrors the CLI's `classifyResourceKind`.
 *
 * Anything that is not text is rejected, and the message tells the model not to
 * retry: re-fetching an image or a PDF will fail the same way.
 */
const classifyResourceKind = (
  contentType: string,
): 'binary' | 'image' | 'text' => {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!normalized) {
    return 'text';
  }

  if (normalized.startsWith('image/')) {
    return 'image';
  }

  if (
    BINARY_CONTENT_TYPES.has(normalized) ||
    normalized.startsWith('video/') ||
    normalized.startsWith('audio/')
  ) {
    return 'binary';
  }

  return 'text';
};

const readErrorBody = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');

  if (!text) {
    return `CodeBuddy web fetch failed with HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text) as { code?: number; msg?: string };

    if (payload.msg) {
      return `CodeBuddy web fetch error: ${payload.msg} (code: ${payload.code ?? 'unknown'})`;
    }
  } catch {
    // Not JSON; fall through to the generic message.
  }

  return `CodeBuddy web fetch failed with HTTP ${response.status}`;
};

export const createCodeBuddyFetchProvider = ({
  maxContentLength,
  resolveEndpoint,
  resolveHost,
  resolveToken,
  timeoutMs: requestedTimeoutMs,
}: {
  maxContentLength?: number;
  resolveEndpoint: EndpointResolver;
  /** Passed through to the local fallback, which resolves the host itself. */
  resolveHost?: HostResolver;
  resolveToken: TokenResolver;
  timeoutMs?: number;
}): WebFetchProvider => {
  const contentLimit = maxContentLength ?? MAX_CONTENT_LENGTH;
  const timeoutMs = Math.min(
    Math.max(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );
  const localFetch = createLocalFetchProvider({
    maxContentLength: contentLimit,
    ...(resolveHost ? { resolveHost } : {}),
    timeoutMs,
  });

  /** Fetches through the CodeBuddy endpoint alone. Rejects on any failure. */
  const fetchViaEndpoint = async ({
    prompt,
    rawUrl,
    token,
  }: {
    prompt?: string;
    rawUrl: string;
    token: string;
  }): Promise<WebFetchResponse> => {
    const endpoint = (await resolveEndpoint()).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // `format: markdown` and `timeout` mirror what the CLI sends: they ask the
      // endpoint for extracted text and let it bound its own fetching.
      const response = await fetch(`${endpoint}${FETCH_PATH}`, {
        body: JSON.stringify({
          format: 'markdown',
          max_length: contentLimit,
          // The CLI treats `prompt` as required; our tool definition keeps it
          // optional because a model asked to "read this page" often sends a URL
          // alone. An empty prompt asks for the whole page, and the model does
          // its own extraction from the result.
          prompt: prompt?.trim().slice(0, MAX_PROMPT_LENGTH) ?? '',
          timeout: Math.floor(timeoutMs / 1000),
          url: rawUrl,
        }),
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        method: 'POST',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(await readErrorBody(response));
      }

      const payload = (await response.json()) as Record<string, unknown>;

      if (payload.code) {
        const message =
          typeof payload.msg === 'string' && payload.msg
            ? payload.msg
            : 'Unknown error';

        throw new Error(`CodeBuddy web fetch error: ${message}`);
      }

      const finalUrl =
        typeof payload.url === 'string' && payload.url.trim()
          ? payload.url.trim()
          : rawUrl;

      // A non-text response is refused rather than returned. The bytes would be
      // decoded as a binary string and fill the transcript with noise, and the
      // model can do nothing with it — the CLI reports the same failure and
      // tells the model not to retry.
      const kind = classifyResourceKind(
        typeof payload.content_type === 'string' ? payload.content_type : '',
      );

      if (kind !== 'text') {
        throw new Error(
          `Web fetch could not read ${finalUrl}: this URL returned a non-text resource, which cannot be returned as text. Do not retry it with this tool.`,
        );
      }

      const content =
        typeof payload.content === 'string'
          ? payload.content.slice(0, contentLimit)
          : '';

      if (!content.trim()) {
        throw new Error(
          `CodeBuddy web fetch found no readable content at ${finalUrl}`,
        );
      }

      return {
        content: formatFetchResult({
          content,
          prompt: prompt?.trim().slice(0, MAX_PROMPT_LENGTH),
          url: finalUrl,
        }),
        url: finalUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Races the endpoint against a local fetch, as the CLI's
   * `fetchWithFallback` does.
   *
   * Both start together. The endpoint wins when it answers first, because its
   * extracted text is better than raw HTML; if it errors or times out, the
   * local result is used instead. Only when both fail is the tool result a
   * failure — which is what makes this backend usable when the endpoint is
   * unavailable or refuses the call.
   *
   * The local attempt is allowed to keep running after the endpoint succeeds,
   * then abandoned: cancelling it mid-flight would be wasted work on a request
   * that has already been answered. Its rejection is swallowed so a losing local
   * fetch never surfaces as an unhandled rejection.
   */
  const fetchPage = async ({
    prompt,
    url,
  }: WebFetchQuery): Promise<WebFetchResponse> => {
    const rawUrl = normalizeFetchUrl(url).slice(0, MAX_URL_LENGTH);

    if (!rawUrl) {
      return {
        content:
          'Web fetch was called without a URL, so nothing was retrieved.',
      };
    }

    const token = (await resolveToken())?.trim();

    if (!token) {
      throw new Error(
        'Authentication required for CodeBuddy web fetch: no credential with a bearer token is available.',
      );
    }

    // The endpoint gets the normalized URL; the local fallback gets the original
    // one. Rewriting `http://` to `https://` is right for a remote endpoint, but
    // forcing it on a page the gateway fetches itself would turn a working
    // plain-HTTP fetch into a failed TLS handshake.
    const endpointAttempt = fetchViaEndpoint({ prompt, rawUrl, token });
    const localAttempt = localFetch.fetch({ prompt, url: url.trim() });

    // Keeps the local promise from becoming an unhandled rejection if the
    // endpoint answers first and nobody ever awaits it.
    localAttempt.catch(() => undefined);

    try {
      return await endpointAttempt;
    } catch (error) {
      let localError: unknown;

      try {
        return await localAttempt;
      } catch (localFailure) {
        localError = localFailure;
      }

      // Both failed: report the endpoint's reason, and the local one too when it
      // differs, so an operator can tell a credentials problem from a fetch
      // problem without re-running the request.
      const endpointReason =
        error instanceof Error ? error.message : String(error);
      const localReason =
        localError instanceof Error
          ? localError.message
          : String(localError ?? 'unknown error');

      throw new Error(
        localReason === endpointReason
          ? endpointReason
          : `${endpointReason} (local fallback also failed: ${localReason})`,
      );
    }
  };

  return { fetch: fetchPage, id: 'codebuddy' };
};
