import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from '../types';

/**
 * SearXNG backend. Reads its configuration from the environment because a
 * search instance is deployment-level infrastructure, not a per-request
 * preference — there is no console UI for the URL.
 */

const SEARXNG_SEARCH_PATH = '/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_SNIPPET_LENGTH = 800;

export interface SearxngOptions {
  apiKey?: string;
  engines?: string;
  language?: string;
  maxResults?: number;
  timeoutMs?: number;
  url: string;
}

const clampInteger = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
};

const readEnv = (name: string): string => {
  const value = process.env[name];

  return typeof value === 'string' ? value.trim() : '';
};

const collapse = (value: string, maxLength: number): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();

  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
};

const formatResults = (query: string, results: WebSearchResult[]): string => {
  if (!results.length) {
    return `Web search for "${query}" returned no results. Answer from your own knowledge and say that the search found nothing.`;
  }

  // Output size is already bounded: at most MAX_MAX_RESULTS entries, each with
  // its snippet truncated to MAX_SNIPPET_LENGTH.
  const lines: string[] = [
    `Web search results for "${query}" (${results.length} result${results.length === 1 ? '' : 's'}):`,
    '',
  ];

  results.forEach((result, index) => {
    const title = result.title?.trim() || '(untitled)';
    const url = result.url?.trim() ?? '';
    const snippet = result.content?.trim() ?? '';

    lines.push(`${index + 1}. ${title}`);

    if (url) {
      lines.push(`   URL: ${url}`);
    }

    if (snippet) {
      lines.push(`   ${snippet}`);
    }

    lines.push('');
  });

  lines.push(
    'Cite the URL of any result you rely on. If the results do not answer the question, say so instead of guessing.',
  );

  return lines.join('\n');
};

const asResult = (item: Record<string, unknown>): WebSearchResult => {
  return {
    content:
      typeof item.content === 'string'
        ? collapse(item.content, MAX_SNIPPET_LENGTH)
        : undefined,
    title:
      typeof item.title === 'string'
        ? collapse(item.title, MAX_TITLE_LENGTH)
        : undefined,
    url: typeof item.url === 'string' ? item.url.trim() : undefined,
  };
};

export const createSearxngProvider = (
  options: SearxngOptions,
): WebSearchProvider => {
  const url = options.url.replace(/\/+$/, '');
  const maxResults = Math.min(
    Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
    MAX_MAX_RESULTS,
  );
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  const search = async (query: string): Promise<WebSearchResponse> => {
    const trimmedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);

    if (!trimmedQuery) {
      return {
        content:
          'Web search was called without a query, so no results could be retrieved.',
        results: [],
      };
    }

    const params = new URLSearchParams({
      format: 'json',
      q: trimmedQuery,
      safesearch: '0',
    });

    if (options.engines) {
      params.set('engines', options.engines);
    }

    if (options.language) {
      params.set('language', options.language);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = new Headers({ Accept: 'application/json' });

      // SearXNG itself has no API key, but one is commonly required by the
      // reverse proxy or rate limiter placed in front of a shared instance.
      if (options.apiKey) {
        headers.set('X-API-Key', options.apiKey);
      }

      const response = await fetch(
        `${url}${SEARXNG_SEARCH_PATH}?${params.toString()}`,
        {
          cache: 'no-store',
          headers,
          method: 'GET',
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`SearXNG responded with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { results?: unknown };
      const raw = Array.isArray(payload.results) ? payload.results : [];
      const results = raw
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object',
        )
        .slice(0, maxResults)
        .map(asResult);

      return { content: formatResults(trimmedQuery, results), results };
    } finally {
      clearTimeout(timer);
    }
  };

  return { id: 'searxng', search };
};

/**
 * Builds the provider from `SEARXNG_URL`, returning `null` when the variable is
 * unset or not an absolute HTTP(S) URL. The console keys the visibility of the
 * web search setting off this being non-null.
 */
export const createSearxngProviderFromEnv = (): WebSearchProvider | null => {
  const rawUrl = readEnv('SEARXNG_URL');

  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return null;
  }

  return createSearxngProvider({
    apiKey: readEnv('SEARXNG_API_KEY'),
    engines: readEnv('SEARXNG_ENGINES'),
    language: readEnv('SEARXNG_LANGUAGE'),
    maxResults: clampInteger(
      process.env.SEARXNG_MAX_RESULTS,
      DEFAULT_MAX_RESULTS,
      1,
      MAX_MAX_RESULTS,
    ),
    timeoutMs: clampInteger(
      process.env.SEARXNG_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    url: rawUrl,
  });
};
