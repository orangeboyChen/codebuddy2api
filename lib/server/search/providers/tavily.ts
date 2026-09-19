/**
 * Tavily backend.
 *
 * A search API built for model consumption: it returns already-extracted page
 * text rather than the short snippets a general engine returns, so a turn that
 * needs the content of a page often finishes without a follow-up `web_fetch`.
 * Needs an API key.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://api.tavily.com/search';

export const createTavilyProvider = ({
  apiKey,
  maxResults,
  timeoutMs,
}: {
  apiKey: string;
  maxResults?: number;
  timeoutMs?: number;
}): WebSearchProvider => {
  return createJsonSearchProvider({
    buildRequest: (query, limit) => ({
      init: {
        body: JSON.stringify({
          // The body field is how the API took the key for a long time; the
          // bearer header is how it documents it now. Both are sent so either
          // form is accepted rather than 401-ing a configured deployment.
          api_key: apiKey,
          max_results: limit,
          query,
          search_depth: 'basic',
        }),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      url: ENDPOINT,
    }),
    extractResults: (payload): WebSearchResult[] =>
      asRecords(payload.results).map((item) =>
        asSearchResult({
          content: item.content,
          title: item.title,
          url: item.url,
        }),
      ),
    id: 'tavily',
    label: 'Tavily',
    maxResults,
    timeoutMs,
  });
};
