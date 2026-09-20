/**
 * Bing Web Search backend.
 *
 * Included because a deployment inside an organisation that already licenses
 * Azure often has a Bing key to hand. Results come from `webPages`; the other
 * sections Bing returns (images, news) are of no use to a text-only tool
 * result. Needs a subscription key.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search';

export const createBingProvider = ({
  apiKey,
  maxResults,
  timeoutMs,
}: {
  apiKey: string;
  maxResults?: number;
  timeoutMs?: number;
}): WebSearchProvider => {
  return createJsonSearchProvider({
    buildRequest: (query, limit) => {
      const params = new URLSearchParams({
        count: String(limit),
        q: query,
      });

      return {
        init: {
          headers: {
            Accept: 'application/json',
            'Ocp-Apim-Subscription-Key': apiKey,
          },
        },
        url: `${ENDPOINT}?${params.toString()}`,
      };
    },
    extractResults: (payload): WebSearchResult[] => {
      const webPages = payload.webPages;

      if (!webPages || typeof webPages !== 'object') {
        return [];
      }

      return asRecords((webPages as Record<string, unknown>).value).map(
        (item) =>
          asSearchResult({
            content: item.snippet,
            title: item.name,
            url: item.url,
          }),
      );
    },
    id: 'bing',
    label: 'Bing',
    maxResults,
    timeoutMs,
  });
};
