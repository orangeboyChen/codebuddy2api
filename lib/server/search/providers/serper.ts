/**
 * Serper backend — Google results through Serper's API.
 *
 * Chosen over Google's own Programmable Search because that one also needs a
 * search-engine id, and a second identifier that only matters to one engine is
 * not worth a settings field. Results are Google's organic hits. Needs an API
 * key.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://google.serper.dev/search';

export const createSerperProvider = ({
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
        body: JSON.stringify({ num: limit, q: query }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        method: 'POST',
      },
      url: ENDPOINT,
    }),
    extractResults: (payload): WebSearchResult[] =>
      asRecords(payload.organic).map((item) =>
        asSearchResult({
          content: item.snippet,
          title: item.title,
          url: item.link,
        }),
      ),
    id: 'serper',
    label: 'Serper',
    maxResults,
    timeoutMs,
  });
};
