/**
 * Shared plumbing for the HTTP search engines.
 *
 * Every engine in this directory is the same shape — build one request, read
 * one JSON document, map it onto results — and differs only in the URL, the
 * credential header, and where the hits live in the payload. Factoring that out
 * leaves each provider as its own request and mapping, and keeps the shared
 * behaviour (one timeout, one result budget, one rendering of the text the
 * model sees) identical across engines.
 */

import {
  collapse,
  formatSearchResults,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
} from '../shared';
import type {
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from '../types';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
const MAX_QUERY_LENGTH = 500;

/** A request the factory will issue. `signal` is added by the factory. */
export interface JsonSearchRequest {
  init?: Omit<RequestInit, 'signal'>;
  url: string;
}

export interface JsonSearchOptions {
  /** The endpoint and credential for one query. */
  buildRequest: (query: string, maxResults: number) => JsonSearchRequest;
  /** Maps the response body onto hits; unknown shapes yield no hits. */
  extractResults: (payload: Record<string, unknown>) => WebSearchResult[];
  id: string;
  /** Name used in the error text a model sees when the call fails. */
  label: string;
  maxResults?: number;
  timeoutMs?: number;
}

/** Keeps only plain objects, so a malformed hit cannot throw downstream. */
export const asRecords = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object',
  );
};

/**
 * Normalizes one hit from whichever field names the engine used.
 *
 * Snippets and titles are collapsed and truncated here rather than per engine:
 * the point of the cap is that no single hit can dominate the prompt, and that
 * is a property of the text the model sees, not of the engine.
 */
export const asSearchResult = (item: {
  content?: unknown;
  title?: unknown;
  url?: unknown;
}): WebSearchResult => {
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

export const createJsonSearchProvider = ({
  buildRequest,
  extractResults,
  id,
  label,
  maxResults: requestedMaxResults,
  timeoutMs: requestedTimeoutMs,
}: JsonSearchOptions): WebSearchProvider => {
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

    const { init, url } = buildRequest(trimmedQuery, maxResults);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${label} search failed with HTTP ${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const results = extractResults(payload).slice(0, maxResults);

      return {
        content: formatSearchResults(trimmedQuery, results),
        results,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return { id, search };
};
