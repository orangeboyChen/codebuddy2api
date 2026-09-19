/**
 * Brave Search backend.
 *
 * A metasearch API with its own index, so results do not depend on a Google or
 * Bing subscription — useful where neither is available. Needs a subscription
 * key; the free tier is enough for the handful of queries a model turn makes.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export const createBraveProvider = ({
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
            'X-Subscription-Token': apiKey,
          },
        },
        url: `${ENDPOINT}?${params.toString()}`,
      };
    },
    extractResults: (payload): WebSearchResult[] => {
      const web = payload.web;

      if (!web || typeof web !== 'object') {
        return [];
      }

      return asRecords((web as Record<string, unknown>).results).map((item) =>
        asSearchResult({
          content: item.description,
          title: item.title,
          url: item.url,
        }),
      );
    },
    id: 'brave',
    label: 'Brave Search',
    maxResults,
    timeoutMs,
  });
};
