import { getCodeBuddyApiEndpoint } from '../domain/config';
import { resolveCodeBuddyToken, type EndpointResolver } from './token';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
  WebSearchProvider,
} from './types';

import { createCodeBuddyFetchProvider } from './providers/codebuddy-fetch';
import { createCodeBuddySearchProvider } from './providers/codebuddy-search';
import { createLocalFetchProvider } from './providers/local-fetch';
import { createSearxngProviderFromEnv } from './providers/searxng';

/**
 * Server-tool backend registry.
 *
 * The proxy only ever talks to `WebSearchProvider` / `WebFetchProvider`, so
 * supporting another backend is a matter of adding a case here. Backends are
 * built per call rather than cached: a CodeBuddy backend is only usable while a
 * credential exists, and a setting change has to take effect on the next
 * request. Both are decisions a startup-time lookup would get wrong.
 *
 * This module deliberately does not read runtime settings — `domain/config`
 * imports back into `search`, so a settings lookup here would close an import
 * cycle. Callers pass the chosen backend in instead.
 */

export type SearchBackend = 'codebuddy' | 'searxng' | 'none';
export type FetchBackend = 'codebuddy' | 'local' | 'none';

export const SEARCH_BACKENDS: readonly SearchBackend[] = [
  'codebuddy',
  'searxng',
  'none',
];
export const FETCH_BACKENDS: readonly FetchBackend[] = [
  'codebuddy',
  'local',
  'none',
];

export const DEFAULT_SEARCH_BACKEND: SearchBackend = 'searxng';
export const DEFAULT_FETCH_BACKEND: FetchBackend = 'none';

const normalizeBackend = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  return (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : fallback;
};

export const normalizeSearchBackend = (value: unknown): SearchBackend =>
  normalizeBackend(value, SEARCH_BACKENDS, DEFAULT_SEARCH_BACKEND);

export const normalizeFetchBackend = (value: unknown): FetchBackend =>
  normalizeBackend(value, FETCH_BACKENDS, DEFAULT_FETCH_BACKEND);

let cachedLocalFetch: WebFetchProvider | null = null;
let cachedSearxng: WebSearchProvider | null | undefined;

/** The local backend holds no state, so one instance serves every request. */
const getLocalFetchProvider = (): WebFetchProvider => {
  cachedLocalFetch ??= createLocalFetchProvider();

  return cachedLocalFetch;
};

/**
 * Caches the SearXNG instance until {@link resetWebSearchProviders}.
 *
 * The cache is keyed on presence, not on the URL: the point is a stable
 * identity for callers that compare providers, and `resetWebSearchProviders`
 * exists precisely for tests and for deployments that change the URL at
 * runtime.
 */
const getSearxngProvider = (): WebSearchProvider | null => {
  if (cachedSearxng === undefined) {
    cachedSearxng = createSearxngProviderFromEnv();
  }

  return cachedSearxng;
};

/**
 * Builds the `web_search` backend named by `backend`.
 *
 * `searxng` degrades to `null` when `SEARXNG_URL` is absent: offering a
 * backend that cannot be constructed would let a deployment advertise a tool
 * it cannot execute.
 */
export const resolveSearchProvider = (
  backend: SearchBackend | string | null | undefined,
  resolveEndpoint: EndpointResolver = getCodeBuddyApiEndpoint,
): WebSearchProvider | null => {
  const resolved = normalizeSearchBackend(backend);

  if (resolved === 'none') {
    return null;
  }

  if (resolved === 'codebuddy') {
    return createCodeBuddySearchProvider({
      resolveEndpoint,
      resolveToken: resolveCodeBuddyToken,
    });
  }

  return getSearxngProvider();
};

/** Builds the `web_fetch` backend named by `backend`. */
export const resolveFetchProvider = (
  backend: FetchBackend | string | null | undefined,
  resolveEndpoint: EndpointResolver = getCodeBuddyApiEndpoint,
): WebFetchProvider | null => {
  const resolved = normalizeFetchBackend(backend);

  if (resolved === 'none') {
    return null;
  }

  if (resolved === 'local') {
    return getLocalFetchProvider();
  }

  return createCodeBuddyFetchProvider({
    resolveEndpoint,
    resolveToken: resolveCodeBuddyToken,
  });
};

/**
 * Whether the SearXNG backend is configured.
 *
 * Re-exported from a leaf module so `domain/config` can call it without
 * importing this registry and closing an import cycle.
 */
export { isLocalWebSearchConfigured } from './searxng-availability';

/** Test seam: clears cached provider instances so env changes are re-read. */
export const resetWebSearchProviders = (): void => {
  cachedLocalFetch = null;
  cachedSearxng = undefined;
};

/** Synchronous accessor used by the console and by existing call sites. */
export const getWebSearchProvider = (): WebSearchProvider | null => {
  return getSearxngProvider();
};

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'timed out';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'unknown error';
};

/**
 * Runs a search, converting any failure into text for the model rather than an
 * exception: the tool result still reaches the model, which can then answer
 * without search or tell the user what went wrong.
 *
 * With no explicit `provider` the backend is resolved from `backend`, the
 * setting the console owns.
 */
export const runWebSearch = async ({
  backend,
  provider,
  query,
  resolveEndpoint,
}: {
  backend?: SearchBackend | string | null;
  provider?: WebSearchProvider | null;
  query: string;
  resolveEndpoint?: EndpointResolver;
}): Promise<string> => {
  const resolved =
    provider !== undefined
      ? provider
      : resolveSearchProvider(backend, resolveEndpoint);

  if (!resolved) {
    return 'Web search is unavailable: no local search backend is configured for this deployment.';
  }

  try {
    const result = await resolved.search(query);

    return result.content;
  } catch (error) {
    return `Web search failed: ${describeError(error)}. Answer without search results and mention that the search failed.`;
  }
};

/**
 * Runs a fetch, converting any failure into text for the model.
 *
 * Failures are reported rather than thrown because the arguments came from the
 * model: the fix is usually to retry with a corrected URL, which the model can
 * only do if it sees the result.
 */
export const runWebFetch = async ({
  backend,
  provider,
  query,
  resolveEndpoint,
}: {
  backend?: FetchBackend | string | null;
  provider?: WebFetchProvider | null;
  query: WebFetchQuery;
  resolveEndpoint?: EndpointResolver;
}): Promise<string> => {
  const resolved =
    provider !== undefined
      ? provider
      : resolveFetchProvider(backend, resolveEndpoint);

  if (!resolved) {
    return 'Web fetch is unavailable: no web fetch backend is enabled for this deployment.';
  }

  try {
    const result: WebFetchResponse = await resolved.fetch(query);

    return result.content;
  } catch (error) {
    return `Web fetch failed: ${describeError(error)}. Answer without the fetched content and mention that the fetch failed.`;
  }
};
