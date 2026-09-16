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
 */

import { formatFetchResult } from '../shared';
import type { EndpointResolver, TokenResolver } from '../token';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
} from '../types';

const FETCH_PATH = '/agenttool/v1/webfetch';
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;

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
  resolveToken,
  timeoutMs: requestedTimeoutMs,
}: {
  maxContentLength?: number;
  resolveEndpoint: EndpointResolver;
  resolveToken: TokenResolver;
  timeoutMs?: number;
}): WebFetchProvider => {
  const contentLimit = maxContentLength ?? MAX_CONTENT_LENGTH;
  const timeoutMs = Math.min(
    Math.max(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  const fetchPage = async ({
    prompt,
    url,
  }: WebFetchQuery): Promise<WebFetchResponse> => {
    const rawUrl = url.trim().slice(0, MAX_URL_LENGTH);

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

    const endpoint = (await resolveEndpoint()).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // `format: markdown` and `timeout` mirror what the CLI sends; they ask
      // the endpoint to return extracted text and to do its own fetching
      // within a bound close to ours.
      const response = await fetch(`${endpoint}${FETCH_PATH}`, {
        body: JSON.stringify({
          format: 'markdown',
          max_length: contentLimit,
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

      const content =
        typeof payload.content === 'string'
          ? payload.content.slice(0, contentLimit)
          : '';
      const finalUrl =
        typeof payload.url === 'string' && payload.url.trim()
          ? payload.url.trim()
          : rawUrl;

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

  return { fetch: fetchPage, id: 'codebuddy' };
};
