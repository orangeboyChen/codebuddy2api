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

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

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
  resolveHost?: HostResolver;
  timeoutMs?: number;
}

/**
 * Maps a hostname to the addresses it should be treated as resolving to.
 *
 * `trusted: true` marks an operator-supplied override (split horizon, a pinned
 * internal host) whose answers are used as given — pinning a name to a private
 * address is legitimate and expected there. `false` marks ordinary DNS, whose
 * answers are untrusted and must all sit in public space.
 */
export type HostResolver = ((hostname: string) => Promise<string[]>) & {
  trusted?: boolean;
};

/** Default resolution: ask DNS. Answers are untrusted. */
const resolveViaDns: HostResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true });

  return records.map((record) => record.address);
};

/**
 * DNS answers only: refuses a name with any private record.
 *
 * Not "first safe address wins" — one private record poisons the name, or a
 * rotated record could select the target.
 */
const assertPublicAddresses = ({
  addresses,
  hostname,
}: {
  addresses: string[];
  hostname: string;
}): void => {
  for (const address of addresses) {
    if (isPrivateHost(address)) {
      throw new Error(
        `Refusing to fetch ${hostname}: it resolves to the private address ${address}`,
      );
    }
  }
};

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
/**
 * Resolves `hostname` to addresses that are all safe to connect to.
 *
 * Checking the hostname string is not enough: an attacker-controlled name can
 * resolve to `127.0.0.1`, an RFC1918 address, or the cloud metadata service, and
 * `fetch` would happily connect there. So the name is resolved here and *every*
 * returned address is validated — a name with any private record is refused
 * outright rather than "first safe address wins", which would let a rotated
 * record pick the target.
 */
const resolvePublicAddresses = async ({
  hostname,
  resolveHost,
}: {
  hostname: string;
  resolveHost: HostResolver;
}): Promise<string[]> => {
  const literal = stripIpBrackets(hostname);

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(literal) || literal.includes(':')) {
    if (isPrivateHost(hostname)) {
      throw new Error(
        `Refusing to fetch a private or loopback address: ${hostname}`,
      );
    }

    return [literal];
  }

  const addresses = await resolvePublic({
    hostname,
    resolveHost,
  });

  // An override is an explicit operator decision, so its answers are used as
  // given. DNS answers are attacker-influenced and must all be public.
  if (!resolveHost.trusted) {
    assertPublicAddresses({ addresses, hostname });
  }

  return addresses;
};

const resolvePublic = async ({
  hostname,
  resolveHost,
}: {
  hostname: string;
  resolveHost: HostResolver;
}): Promise<string[]> => {
  let addresses: string[];

  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new Error(`Web fetch could not resolve host: ${hostname}`);
  }

  if (!addresses.length) {
    throw new Error(`Web fetch could not resolve host: ${hostname}`);
  }

  return addresses;
};

/**
 * Builds a `lookup` hook that pins the connection to `address`.
 *
 * Pinning is what makes the resolution above mean anything. Without it the
 * socket would resolve the name again — and an attacker who controls DNS can
 * return a public address to the check and a private one to the connection
 * (DNS rebinding), defeating validation entirely.
 *
 * `all` is honoured because Node asks for either one address or the full list;
 * always answering with the pinned one keeps both paths correct.
 */
const createPinnedLookup =
  (address: string) =>
  (
    _hostname: string,
    options: { all?: boolean },
    callback: (
      error: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if (options.all) {
      callback(null, [{ address, family: 4 }]);
      return;
    }

    callback(null, address, 4);
  };

/**
 * Reads at most `maxBytes` from a response stream, then cancels it.
 *
 * Buffering the whole body first would let a hostile or merely enormous page
 * occupy unbounded memory for the length of the timeout; cancelling as soon as
 * the cap is reached stops the download instead of finishing it and throwing the
 * excess away.
 *
 * The cap counts decoded characters, so multibyte text cannot smuggle in more
 * content than intended.
 */
const readCappedText = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    // The cap is checked *after* each read, not before. Checking first would
    // block on the next chunk, so a server that trickles bytes — or never
    // finishes the body — would hold the reader until the timeout instead of
    // stopping as soon as enough text has arrived.
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });

      if (text.length >= maxBytes) {
        break;
      }
    }

    // Flush any trailing partial sequence so the text is complete.
    text += decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  return text;
};

interface PinnedResponse {
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
  stream: ReadableStream<Uint8Array>;
}

/**
 * Issues one GET that is pinned to `addresses`.
 *
 * Node's `fetch` is deliberately not used: it re-resolves the hostname after
 * validation, which is exactly the rebinding window this closes. `http`/`https`
 * accept a `lookup` hook, so the socket connects to the already-validated
 * address while `Host` and `servername` keep the real hostname, preserving
 * virtual-host routing and TLS SNI.
 *
 * Redirects are not followed here — the caller handles them, so each hop gets
 * validated and pinned afresh.
 */
const requestPinned = ({
  addresses,
  headers,
  hostname,
  path,
  port,
  timeoutMs,
  transport,
}: {
  addresses: string[];
  headers: Record<string, string>;
  hostname: string;
  path: string;
  port: number;
  timeoutMs: number;
  transport: typeof http | typeof https;
}): Promise<PinnedResponse> => {
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;

    const request = transport.request(
      {
        headers,
        host: hostname,
        // The first validated address is pinned for this connection. Every
        // address passed validation, so any is safe to use.
        lookup: createPinnedLookup(addresses[0] as string),
        method: 'GET',
        path,
        port,
        // TLS needs the real hostname: the certificate and SNI are keyed to it,
        // not to the pinned address.
        servername: transport === https ? hostname : undefined,
      },
      (response) => {
        if (settled) {
          response.resume();
          return;
        }

        settled = true;
        clearTimeout(timer);

        // A socket idle timeout as well as the wall-clock one. The wall clock
        // bounds the whole request, but once a response has started a server can
        // still stall mid-body, and the reader would then wait on `read()` until
        // something tears the socket down. This is that something.
        response.setTimeout(timeoutMs, () => {
          response.destroy(
            new Error(`Web fetch timed out after ${timeoutMs}ms`),
          );
        });

        resolve({
          contentType:
            typeof response.headers['content-type'] === 'string'
              ? response.headers['content-type']
              : '',
          headers: response.headers,
          status: response.statusCode ?? 0,
          stream: ReadableStreamFrom(response) as ReadableStream<Uint8Array>,
        });
      },
    );

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy(new Error(`Web fetch timed out after ${timeoutMs}ms`));
      reject(new Error(`Web fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    request.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    request.end();
  });
};

/**
 * Adapts a Node response to a web ReadableStream.
 *
 * The indirection keeps the request path uniform with the rest of the codebase,
 * and gives callers one obvious way to stop reading: cancel the stream.
 */
const ReadableStreamFrom = (
  response: http.IncomingMessage,
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    cancel() {
      response.destroy();
    },
    start(controller) {
      response.on('data', (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk),
        );
      });
      response.on('end', () => {
        try {
          controller.close();
        } catch {
          // Already closed by a consumer that stopped reading.
        }
      });
      response.on('error', (error: Error) => {
        try {
          controller.error(error);
        } catch {
          // Already closed.
        }
      });
    },
  });
};

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
 * Validates a URL before it is handed to a *remote* fetch backend.
 *
 * The URL comes from the model, so a backend that fetches on this machine's
 * behalf is not the only one that has to refuse it: handing a model-supplied
 * `http://169.254.169.254/...` or `http://127.0.0.1:8001/...` to a reader
 * service or a browser agent would fetch it from wherever *that* service sits
 * and hand the body straight back to the model. Without this, picking one of
 * those backends would defeat the guard this file applies to its own fetch.
 *
 * Only what is visible in the URL is checked. A name that resolves to a private
 * address cannot be caught without resolving it, and resolving it here would
 * prove nothing — the connection is made by the remote service, not by this
 * one — so literals and non-HTTP schemes are what this refuses.
 */
export const assertRemotelyFetchableUrl = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().slice(0, MAX_URL_LENGTH);

  if (!trimmed) {
    throw new Error(
      'Web fetch was called without a URL, so nothing was retrieved.',
    );
  }

  const parsed = parseUrl(trimmed);

  if (!parsed) {
    throw new Error(
      `Web fetch could not run: "${trimmed}" is not a valid absolute URL.`,
    );
  }

  assertFetchableUrl(parsed);

  return parsed.toString();
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
  resolveHost = resolveViaDns,
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

    let currentUrl = parsed;

    // Redirects are followed manually so every hop is re-validated, and each hop
    // re-resolves and re-pins: a public URL that redirects to a private address
    // must not be followed, and a pinned address must never be reused across
    // hosts.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertFetchableUrl(currentUrl);

      const addresses = await resolvePublicAddresses({
        hostname: currentUrl.hostname,
        resolveHost,
      });
      const isHttps = currentUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const response = await requestPinned({
        addresses,
        headers: {
          Accept:
            'text/markdown, text/html, application/xhtml+xml, application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': BROWSER_USER_AGENT,
        },
        hostname: currentUrl.hostname,
        path: `${currentUrl.pathname}${currentUrl.search}`,
        port: currentUrl.port ? Number(currentUrl.port) : isHttps ? 443 : 80,
        timeoutMs,
        transport,
      });

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        if (response.status < 200 || response.status >= 300) {
          void response.stream.cancel();
          throw new Error(
            `Web fetch failed with HTTP ${response.status} for ${currentUrl.toString()}`,
          );
        }

        const contentType = response.contentType;

        if (!isTextContentType(contentType)) {
          void response.stream.cancel();
          throw new Error(
            `Web fetch could not read ${currentUrl.toString()}: unsupported content type ${contentType || 'unknown'}`,
          );
        }

        // Read only slightly more than the limit. HTML is converted before
        // truncation, and a tag can run past the cut, so a small margin is
        // needed for the trimmed result to still be a full `contentLimit`.
        const body = await readCappedText(response.stream, contentLimit * 2);
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

      const rawLocation = response.headers.location;
      const location = Array.isArray(rawLocation)
        ? rawLocation[0]
        : rawLocation;

      if (!location) {
        void response.stream.cancel();
        throw new Error(
          `Web fetch received a redirect with no target from ${currentUrl.toString()}`,
        );
      }

      void response.stream.cancel();
      currentUrl = new URL(location, currentUrl);
    }

    throw new Error(`Web fetch followed more than ${MAX_REDIRECTS} redirects`);
  };

  return { fetch: fetchPage, id: 'local' };
};
