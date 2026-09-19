import {
  clampInteger,
  collapse,
  formatSearchResults,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
  readEnv,
} from '../shared';
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from '../types';

/**
 * SearXNG backend.
 *
 * The self-hosted option: one instance covers every user of the gateway and no
 * query leaves the deployment's own network, which is why it is the default
 * where an instance exists. Its address and optional key are console settings,
 * with the environment as a fallback for deployments configured before the
 * console had them.
 */

const SEARXNG_SEARCH_PATH = '/search';
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 500;

export interface SearxngOptions {
  apiKey?: string;
  engines?: string;
  language?: string;
  maxResults?: number;
  timeoutMs?: number;
  url: string;
}

/**
 * Appends engine selection to the query using SearXNG's bang syntax.
 *
 * `/search` has no `engines` parameter — `webapp.py` only reads `q`, `format`,
 * and `timeout_limit` from the request. Engines are selected inside the query
 * itself: each `!name` token is parsed by the bang parser and resolved against
 * engine names, engine shortcuts, or category names. Multiple space-separated
 * bangs accumulate, so `google` + `bing` becomes `!google !bing <query>`.
 *
 * Values are sanitised to a single token because the parser matches the whole
 * bang token against the engine table — a stray space or comma would make it
 * part of the search text instead.
 */
const buildSearxngQuery = (query: string, engines?: string): string => {
  if (!engines) {
    return query;
  }

  const bangs = engines
    .split(/[\s,]+/)
    .map((engine) => engine.trim().replace(/^!+/, ''))
    .filter((engine) => /^[A-Za-z0-9_-]+$/.test(engine))
    .map((engine) => `!${engine}`);

  if (!bangs.length) {
    return query;
  }

  return `${bangs.join(' ')} ${query}`;
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
      q: buildSearxngQuery(trimmedQuery, options.engines),
      safesearch: '0',
    });

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

      if (response.status === 403) {
        // `format=json` is opt-in: it must be listed under `search.formats` in
        // the instance's settings.yml, and many instances leave it off (public
        // ones especially). Without this hint the failure looks like an opaque
        // auth error rather than a deployment setting.
        throw new Error(
          `SearXNG responded with HTTP 403 — the instance has not enabled the JSON output format. Add "json" to the "search.formats" list in the instance's settings.yml (or use an instance that supports it).`,
        );
      }

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

      return {
        content: formatSearchResults(trimmedQuery, results),
        results,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return { id: 'searxng', search };
};

/**
 * Builds the provider from the console setting, falling back to the
 * environment.
 *
 * Two sources because SearXNG predates the console settings: a deployment
 * already running `SEARXNG_URL` keeps working untouched, while a new one can
 * enter the instance address in the console instead. The console wins where
 * both are set, because it is the one an operator can change without a restart.
 *
 * Returns `null` when neither supplies an absolute HTTP(S) URL, so a deployment
 * without an instance does not advertise a search tool it cannot run.
 */
export const createSearxngProviderFromSettings = (
  settings: { apiKey?: string; url?: string } = {},
): WebSearchProvider | null => {
  const rawUrl = settings.url?.trim() || readEnv('SEARXNG_URL');

  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return null;
  }

  return createSearxngProvider({
    apiKey: settings.apiKey?.trim() || readEnv('SEARXNG_API_KEY'),
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

/** Environment-only construction, for callers that cannot reach the settings. */
export const createSearxngProviderFromEnv = (): WebSearchProvider | null =>
  createSearxngProviderFromSettings();
