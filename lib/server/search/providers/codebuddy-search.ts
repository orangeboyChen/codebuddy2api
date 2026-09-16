/**
 * CodeBuddy's own search backend, at `{endpoint}/agenttool/v1/search`.
 *
 * This is the same endpoint the CodeBuddy CLI calls for its WebSearch tool, so
 * it needs no extra deployment — the credentials already in the gateway are
 * what authenticate the call. It is the natural default for a deployment that
 * has no SearXNG instance and does not want to run one.
 *
 * A credential is required: unlike the model endpoint, this one rejects the
 * call outright without a bearer token, so the backend reports itself
 * unavailable rather than issuing a request that is certain to fail.
 */

import {
  collapse,
  formatSearchResults,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
} from '../shared';
import type { EndpointResolver, TokenResolver } from '../token';
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from '../types';

const SEARCH_PATH = '/agenttool/v1/search';
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 500;

/**
 * Mirrors the CLI's own timeout. The endpoint is on the critical path of a
 * model turn, so waiting longer than the CLI would only stalls the request.
 */

/**
 * Bearer token for the agent-tool endpoints.
 *
 * Read lazily at call time rather than captured when the provider is built:
 * credentials rotate while the process runs, and a provider resolved once at
 * startup would keep using a token that has since been replaced.
 */

const asResult = (item: Record<string, unknown>): WebSearchResult => {
  return {
    content:
      typeof item.snippet === 'string'
        ? collapse(item.snippet, MAX_SNIPPET_LENGTH)
        : typeof item.content === 'string'
          ? collapse(item.content, MAX_SNIPPET_LENGTH)
          : undefined,
    title:
      typeof item.title === 'string'
        ? collapse(item.title, MAX_TITLE_LENGTH)
        : undefined,
    url: typeof item.url === 'string' ? item.url.trim() : undefined,
  };
};

const readErrorBody = async (response: Response): Promise<string> => {
  const text = await response.text().catch(() => '');

  if (!text) {
    return `CodeBuddy web search failed with HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text) as { code?: number; msg?: string };

    if (payload.msg) {
      return `CodeBuddy web search error: ${payload.msg} (code: ${payload.code ?? 'unknown'})`;
    }
  } catch {
    // Not JSON; fall through to the generic message.
  }

  return `CodeBuddy web search failed with HTTP ${response.status}`;
};

export const createCodeBuddySearchProvider = ({
  maxResults: requestedMaxResults,
  resolveEndpoint,
  resolveToken,
  timeoutMs: requestedTimeoutMs,
}: {
  maxResults?: number;
  resolveEndpoint: EndpointResolver;
  resolveToken: TokenResolver;
  timeoutMs?: number;
}): WebSearchProvider => {
  const maxResults = Math.min(
    Math.max(requestedMaxResults ?? DEFAULT_MAX_RESULTS, 1),
    MAX_MAX_RESULTS,
  );
  const timeoutMs = Math.min(
    Math.max(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
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

    const token = (await resolveToken())?.trim();

    if (!token) {
      throw new Error(
        'Authentication required for CodeBuddy web search: no credential with a bearer token is available.',
      );
    }

    const endpoint = (await resolveEndpoint()).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${endpoint}${SEARCH_PATH}`, {
        body: JSON.stringify({
          max_results: maxResults,
          query: trimmedQuery,
          type: 'text2text',
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

        throw new Error(`CodeBuddy web search error: ${message}`);
      }

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

  return { id: 'codebuddy', search };
};
