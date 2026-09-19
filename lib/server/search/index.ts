import { getCodeBuddyApiEndpoint } from '../domain/config';
import {
  normalizeFetchBackends,
  normalizeSearchBackend,
  type FetchBackend,
  type SearchBackend,
} from './tool';
import { resolveCodeBuddyToken, type EndpointResolver } from './token';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
  WebSearchProvider,
  WebSearchResponse,
} from './types';
import type {
  FetchBackendSettings,
  ResolveBackendOptions,
  SearchBackendSettings,
} from './settings';

import { createBrowserableProvider } from './providers/browserable';
import { createBingProvider } from './providers/bing';
import { createBraveProvider } from './providers/brave';
import { createCodeBuddyFetchProvider } from './providers/codebuddy-fetch';
import { createCodeBuddySearchProvider } from './providers/codebuddy-search';
import { createDuckduckgoProvider } from './providers/duckduckgo';
import { createExaProvider } from './providers/exa';
import { createJinaFetchProvider } from './providers/jina';
import { createLocalFetchProvider } from './providers/local-fetch';
import { createSearxngProviderFromSettings } from './providers/searxng';
import { createSerperProvider } from './providers/serper';
import { createTavilyProvider } from './providers/tavily';

/**
 * Server-tool backend registry.
 *
 * The proxy only ever talks to `WebSearchProvider` / `WebFetchProvider`, so
 * supporting another backend is a matter of adding a case here. Search resolves
 * to one provider — the console picks one engine — while fetch resolves to a
 * chain, because the console lets a deployment select several and try them in
 * order.
 *
 * Credentialed backends are built per call rather than cached: a CodeBuddy
 * backend is only usable while a credential exists, and a setting change has to
 * take effect on the next request. Both are decisions a startup-time lookup
 * would get wrong.
 *
 * This module deliberately does not read runtime settings — `domain/config`
 * imports back into `search`, so a settings lookup here would close an import
 * cycle. Callers pass the resolved settings in instead.
 */

export type { FetchBackend, SearchBackend } from './tool';
export * from './backends';
export type {
  FetchBackendSettings,
  ResolveBackendOptions,
  SearchBackendSettings,
} from './settings';

/** The local backend holds no state, so one instance serves every request. */
let cachedLocalFetch: WebFetchProvider | null = null;

const getLocalFetchProvider = (): WebFetchProvider => {
  cachedLocalFetch ??= createLocalFetchProvider();

  return cachedLocalFetch;
};

/** Test seam: clears cached provider instances so env changes are re-read. */
export const resetWebSearchProviders = (): void => {
  cachedLocalFetch = null;
};

/**
 * Builds the `web_search` backend named by `backend`.
 *
 * Returns `null` when the chosen engine cannot run — an engine whose API key was
 * never entered, or SearXNG with no instance URL. Advertising a backend that
 * cannot be constructed would let a deployment promise a tool it cannot
 * execute, so the tool is withdrawn from the request instead.
 */
export const resolveSearchProvider = (
  backend: SearchBackend | string | null | undefined,
  options: ResolveBackendOptions = {},
): WebSearchProvider | null => {
  const resolved = normalizeSearchBackend(backend);
  const { resolveEndpoint = getCodeBuddyApiEndpoint, search: settings = {} } =
    options;

  if (resolved === 'codebuddy') {
    return createCodeBuddySearchProvider({
      resolveEndpoint,
      resolveToken: resolveCodeBuddyToken,
    });
  }

  // Needs no credential, so it runs for any deployment that selects it.
  if (resolved === 'duckduckgo') {
    return createDuckduckgoProvider({ region: settings.duckduckgoRegion });
  }

  if (resolved === 'searxng') {
    // Built per call: the URL comes from the console, and a deployment may
    // point at another instance without restarting.
    return createSearxngProviderFromSettings({
      apiKey: settings.searxngApiKey,
      url: settings.searxngUrl,
    });
  }

  const apiKey = {
    brave: settings.braveApiKey,
    bing: settings.bingApiKey,
    exa: settings.exaApiKey,
    serper: settings.serperApiKey,
    tavily: settings.tavilyApiKey,
  }[resolved]?.trim();

  if (!apiKey) {
    return null;
  }

  return {
    brave: createBraveProvider,
    bing: createBingProvider,
    exa: createExaProvider,
    serper: createSerperProvider,
    tavily: createTavilyProvider,
  }[resolved]({ apiKey });
};

const resolveOneFetchProvider = (
  backend: FetchBackend,
  options: {
    fetch: FetchBackendSettings;
    resolveEndpoint: EndpointResolver;
  },
): WebFetchProvider | null => {
  const { fetch: settings, resolveEndpoint } = options;

  if (backend === 'codebuddy') {
    return createCodeBuddyFetchProvider({
      resolveEndpoint,
      resolveToken: resolveCodeBuddyToken,
    });
  }

  if (backend === 'codebuddy2api') {
    return getLocalFetchProvider();
  }

  if (backend === 'jina') {
    return createJinaFetchProvider({ apiKey: settings.jinaApiKey });
  }

  const url = settings.browserableUrl?.trim();

  if (!url) {
    return null;
  }

  return createBrowserableProvider({
    apiKey: settings.browserableApiKey,
    url,
  });
};

/**
 * Builds every selected `web_fetch` backend, in selection order.
 *
 * Backends that cannot run — Browserable with no address — are dropped rather
 * than kept as entries certain to fail.
 */
export const resolveFetchProviders = (
  backends: FetchBackend | readonly FetchBackend[] | string | null | undefined,
  options: ResolveBackendOptions = {},
): WebFetchProvider[] => {
  const {
    fetch: fetchSettings = {},
    resolveEndpoint = getCodeBuddyApiEndpoint,
  } = options;

  return normalizeFetchBackends(backends).flatMap((backend) => {
    const provider = resolveOneFetchProvider(backend, {
      fetch: fetchSettings,
      resolveEndpoint,
    });

    return provider ? [provider] : [];
  });
};

/**
 * Builds the `web_fetch` backend for a selection, as one provider.
 *
 * Several selections compose into a chain tried in order: picking a fast
 * backend and a slow one gets the fast answer when the fast one works and still
 * gets an answer when it does not. `null` means nothing was selected, which is
 * how a deployment turns the tool off.
 */
export const resolveFetchProvider = (
  backends: FetchBackend | readonly FetchBackend[] | string | null | undefined,
  options: ResolveBackendOptions = {},
): WebFetchProvider | null => {
  const providers = resolveFetchProviders(backends, options);

  if (!providers.length) {
    return null;
  }

  return providers.length === 1
    ? providers[0]
    : createFallbackFetchProvider(providers);
};

/**
 * Tries each provider in turn and keeps the first answer.
 *
 * Only the last failure is reported, because the caller needs one reason to
 * show the model; the earlier ones are logged so an operator can still see
 * which hop broke.
 */
const createFallbackFetchProvider = (
  providers: readonly WebFetchProvider[],
): WebFetchProvider => {
  const fetchPage = async (query: WebFetchQuery): Promise<WebFetchResponse> => {
    let lastError: unknown = null;

    for (const [index, provider] of providers.entries()) {
      try {
        return await provider.fetch(query);
      } catch (error) {
        lastError = error;

        if (index < providers.length - 1) {
          console.warn('[CodeBuddy2API] Web fetch backend failed', {
            backend: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('every configured web fetch backend failed');
  };

  return {
    fetch: fetchPage,
    id: `fallback(${providers.map((provider) => provider.id).join('+')})`,
  };
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
export const runWebSearchResult = async ({
  backend,
  provider,
  query,
  resolveEndpoint,
  search,
}: {
  backend?: SearchBackend | string | null;
  provider?: WebSearchProvider | null;
  query: string;
  resolveEndpoint?: EndpointResolver;
  search?: SearchBackendSettings;
}): Promise<WebSearchResponse> => {
  const resolved =
    provider !== undefined
      ? provider
      : resolveSearchProvider(backend, { resolveEndpoint, search });

  if (!resolved) {
    return {
      content:
        'Web search is unavailable: no search backend is configured for this deployment.',
      results: [],
    };
  }

  try {
    return await resolved.search(query);
  } catch (error) {
    return {
      content: `Web search failed: ${describeError(error)}. Answer without search results and mention that the search failed.`,
      results: [],
    };
  }
};

export const runWebSearch = async (
  options: Parameters<typeof runWebSearchResult>[0],
): Promise<string> => (await runWebSearchResult(options)).content;

/**
 * Runs a fetch, converting any failure into text for the model.
 *
 * Failures are reported rather than thrown because the arguments came from the
 * model: the fix is usually to retry with a corrected URL, which the model can
 * only do if it sees the result.
 */
export const runWebFetchResult = async ({
  backend,
  fetch: fetchSettings,
  provider,
  query,
  resolveEndpoint,
}: {
  backend?: FetchBackend | readonly FetchBackend[] | string | null;
  fetch?: FetchBackendSettings;
  provider?: WebFetchProvider | null;
  query: WebFetchQuery;
  resolveEndpoint?: EndpointResolver;
}): Promise<WebFetchResponse> => {
  const resolved =
    provider !== undefined
      ? provider
      : resolveFetchProvider(backend, {
          fetch: fetchSettings,
          resolveEndpoint,
        });

  if (!resolved) {
    return {
      content:
        'Web fetch is unavailable: no web fetch backend is enabled for this deployment.',
    };
  }

  try {
    return await resolved.fetch(query);
  } catch (error) {
    return {
      content: `Web fetch failed: ${describeError(error)}. Answer without the fetched content and mention that the fetch failed.`,
    };
  }
};

export const runWebFetch = async (
  options: Parameters<typeof runWebFetchResult>[0],
): Promise<string> => (await runWebFetchResult(options)).content;
