/**
 * Local `web_fetch` backend — the gateway fetches the page itself.
 *
 * This is what the CodeBuddy CLI falls back to when its own fetch endpoint is
 * unavailable, and it is the only option for a deployment pointed at an
 * endpoint that does not expose `/agenttool/v1/webfetch`.
 *
 * Because the URL comes from the model, the fetch is treated as untrusted
 * input: private and loopback addresses are refused before any connection is
 * made, redirects are re-checked at every hop, and the body is capped. Without
 * those checks a prompt-injected URL would turn the gateway into an open proxy
 * onto its own network.
 */

import { formatFetchResult } from '../shared';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
} from '../types';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
/** Matches the CLI's own cap: page text beyond this is not worth the tokens. */
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 500;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2_048;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface LocalFetchOptions {
  maxContentLength?: number;
  timeoutMs?: number;
}

const stripIpBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

const isPrivateIPv4 = (parts: number[]): boolean => {
  const [a, b] = parts;

  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
};

const isPrivateIPv6 = (host: string): boolean => {
  const normalized = host.toLowerCase();

  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fe80') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  );
};

/**
 * Whether `host` resolves inside the deployment's own network.
 *
 * IPs are tested directly; anything else is allowed through, because resolving
 * a hostname here would only add a lookup the fetch is about to do anyway —
 * and a DNS name that maps to a private address is still caught because the
 * check runs again on each redirect target.
 */
const isPrivateHost = (host: string): boolean => {
  const bare = stripIpBrackets(host);

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const parts = bare.split('.').map(Number);

    if (parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)) {
      return isPrivateIPv4(parts);
    }
  }

  if (bare.includes(':')) {
    return isPrivateIPv6(bare);
  }

  const lower = bare.toLowerCase();

  return lower === 'localhost' || lower.endsWith('.localhost');
};

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
};

/**
 * Refuses anything that is not a plain HTTP(S) URL to a public host.
 *
 * `blob:`, `data:`, `file:` and friends never reach this check with a usable
 * origin, and a non-HTTP scheme would bypass the host test entirely, so the
 * protocol is validated first rather than being filtered separately.
 */
const assertFetchableUrl = (url: URL): void => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  if (isPrivateHost(url.hostname)) {
    throw new Error(
      `Refusing to fetch a private or loopback address: ${url.hostname}`,
    );
  }
};

/**
 * Recognises content the model cannot read as text.
 *
 * A PDF or image would otherwise be decoded as a binary string and dumped into
 * the transcript, which is both useless and expensive.
 */
const isTextContentType = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();

  if (!normalized) {
    return true;
  }

  if (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript')
  ) {
    return true;
  }

  return false;
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code) || 32),
    );

/**
 * Converts HTML to readable text without a parsing dependency.
 *
 * Script, style and head content is dropped first — it is noise that would
 * otherwise survive into the prompt. Block-level tags then become newlines so
 * the result keeps its paragraph structure instead of collapsing into one
 * unreadable run. This is deliberately lossy: the goal is text a model can
 * read, not a faithful rendering.
 */
const htmlToText = (html: string): string => {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '');

  const withBreaks = withoutNoise
    .replace(
      /<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<(p|div|li|tr|h[1-6]|section|article)\b[^>]*>/gi, '\n');

  const text = withBreaks.replace(/<[^>]*>/g, ' ');

  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** Extracts a readable body, preferring converted HTML but keeping plain text. */
const toReadableText = (body: string, contentType: string): string => {
  const looksLikeHtml =
    contentType.includes('html') ||
    contentType.includes('xml') ||
    /^\s*<!doctype html|<html[\s>]/i.test(body);

  return looksLikeHtml ? htmlToText(body) : body.trim();
};

export const createLocalFetchProvider = ({
  maxContentLength,
  timeoutMs: requestedTimeoutMs,
}: LocalFetchOptions = {}): WebFetchProvider => {
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

    const parsed = parseUrl(rawUrl);

    if (!parsed) {
      return {
        content: `Web fetch could not run: "${rawUrl}" is not a valid absolute URL.`,
      };
    }

    assertFetchableUrl(parsed);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let currentUrl = parsed;

    try {
      // Redirects are followed manually so each hop can be re-validated: a
      // public URL that redirects to a private address must not be followed.
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (hop > 0) {
          assertFetchableUrl(currentUrl);
        }

        const response = await fetch(currentUrl.toString(), {
          cache: 'no-store',
          headers: {
            Accept:
              'text/markdown, text/html, application/xhtml+xml, application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': BROWSER_USER_AGENT,
          },
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });

        if (![301, 302, 303, 307, 308].includes(response.status)) {
          const contentType = response.headers.get('content-type') ?? '';

          if (!response.ok) {
            throw new Error(
              `Web fetch failed with HTTP ${response.status} for ${currentUrl.toString()}`,
            );
          }

          if (!isTextContentType(contentType)) {
            throw new Error(
              `Web fetch could not read ${currentUrl.toString()}: unsupported content type ${contentType || 'unknown'}`,
            );
          }

          const body = await response.text();
          const text = toReadableText(body, contentType).slice(0, contentLimit);

          if (!text.trim()) {
            throw new Error(
              `Web fetch found no readable content at ${currentUrl.toString()}`,
            );
          }

          return {
            content: formatFetchResult({
              content: text,
              prompt: prompt?.trim().slice(0, MAX_PROMPT_LENGTH),
              url: currentUrl.toString(),
            }),
            url: currentUrl.toString(),
          };
        }

        const location = response.headers.get('location');

        if (!location) {
          throw new Error(
            `Web fetch received a redirect with no target from ${currentUrl.toString()}`,
          );
        }

        const next = new URL(location, currentUrl);
        currentUrl = next;
      }

      throw new Error(
        `Web fetch followed more than ${MAX_REDIRECTS} redirects`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return { fetch: fetchPage, id: 'local' };
};
