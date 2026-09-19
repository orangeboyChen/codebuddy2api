/**
 * Exa backend.
 *
 * A semantic search API: it matches the meaning of a query rather than its
 * keywords, which is what a model's query usually expresses. Page text comes
 * back with the hits, so the result is closer to a fetched page than to a list
 * of snippets. Needs an API key.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://api.exa.ai/search';
/**
 * Per-hit character budget for the page text Exa returns.
 *
 * Kept well under the snippet cap: with full text on offer a single hit can
 * otherwise fill the whole tool result and crowd out the others.
 */
const MAX_TEXT_CHARACTERS = 1_000;

export const createExaProvider = ({
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
          contents: { text: { maxCharacters: MAX_TEXT_CHARACTERS } },
          numResults: limit,
          query,
        }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        method: 'POST',
      },
      url: ENDPOINT,
    }),
    extractResults: (payload): WebSearchResult[] =>
      asRecords(payload.results).map((item) =>
        asSearchResult({
          content: item.text,
          title: item.title,
          url: item.url,
        }),
      ),
    id: 'exa',
    label: 'Exa',
    maxResults,
    timeoutMs,
  });
};
