import type { WebSearchProvider } from './types';

import { createSearxngProviderFromEnv } from './providers/searxng';

/**
 * Local web search registry.
 *
 * The proxy only ever talks to `WebSearchProvider`, so supporting another
 * backend is a matter of adding its factory here. Providers are tried in
 * order and the first one that is configured wins; today SearXNG is the only
 * implementation, configured through `SEARXNG_URL`.
 */
const providerFactories: Array<() => WebSearchProvider | null> = [
  createSearxngProviderFromEnv,
];

let cachedProvider: WebSearchProvider | null | undefined;

const resolveProvider = (): WebSearchProvider | null => {
  if (cachedProvider === undefined) {
    cachedProvider =
      providerFactories
        .map((factory) => factory())
        .find((provider): provider is WebSearchProvider => provider !== null) ??
      null;
  }

  return cachedProvider;
};

/** Test seam: clears the cached provider so env changes are re-read. */
export const resetWebSearchProviders = (): void => {
  cachedProvider = undefined;
};

export const getWebSearchProvider = (): WebSearchProvider | null => {
  return resolveProvider();
};

/**
 * Whether any backend is configured. The console uses this to decide whether
 * to show the "enable local web search" setting at all.
 */
export const isLocalWebSearchConfigured = (): boolean => {
  return resolveProvider() !== null;
};

/**
 * Runs a query, converting any failure into text for the model rather than an
 * exception: the tool result still reaches the model, which can then answer
 * without search or tell the user what went wrong.
 */
export const runWebSearch = async ({
  query,
  provider = resolveProvider(),
}: {
  query: string;
  provider?: WebSearchProvider | null;
}): Promise<string> => {
  if (!provider) {
    return 'Web search is unavailable: no local search backend is configured for this deployment.';
  }

  try {
    const result = await provider.search(query);

    return result.content;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'timed out'
        : error instanceof Error
          ? error.message
          : 'unknown error';

    return `Web search failed: ${reason}. Answer without search results and mention that the search failed.`;
  }
};
