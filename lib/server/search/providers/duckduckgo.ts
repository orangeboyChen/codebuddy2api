/**
 * DuckDuckGo Instant Answer backend.
 *
 * The only engine here that needs no credential: the instant-answer endpoint is
 * open, so a deployment with nothing but this gateway gets a working
 * `web_search`. That makes it the safe choice when a SearXNG instance or a paid
 * search API is not available.
 *
 * The trade-off is that instant answers are a curated summary, not a page of
 * web hits: queries with no matching topic come back empty even though a search
 * engine would have found pages. Engines with a key (Brave, Tavily, Serper,
 * Bing, Exa) return ordinary web results and are the better choice where one is
 * available.
 */

import {
  asRecords,
  asSearchResult,
  createJsonSearchProvider,
} from './json-search';
import type { WebSearchProvider, WebSearchResult } from '../types';

const ENDPOINT = 'https://api.duckduckgo.com/';
export const DEFAULT_DUCKDUCKGO_REGION = 'wt-wt';
const REGION_PATTERN = /^[a-z]{2}-[a-z]{2}$/;
const MAX_TOPIC_DEPTH = 3;

/**
 * Region codes are `kl` values (`wt-wt`, `cn-zh`, `us-en`). Anything else —
 * empty, misspelled, a whole locale string — falls back to worldwide rather
 * than being sent as-is, which the endpoint would reject.
 */
export const normalizeDuckduckgoRegion = (value: unknown): string => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  return REGION_PATTERN.test(normalized)
    ? normalized
    : DEFAULT_DUCKDUCKGO_REGION;
};

/**
 * `RelatedTopics` mixes result entries with nested groups, each of which holds
 * another list of entries, so the list is flattened before use. The depth cap
 * is a guard against a payload shaped more deeply than documented.
 */
const flattenTopics = (
  topics: unknown,
  depth = 0,
): Record<string, unknown>[] => {
  if (depth > MAX_TOPIC_DEPTH) {
    return [];
  }

  return asRecords(topics).flatMap((topic) => [
    topic,
    ...flattenTopics(topic.Topics, depth + 1),
  ]);
};

/**
 * Instant answers carry no page title, only a URL and a line of text, so the
 * host stands in for the title. A hit whose URL cannot be parsed keeps its text
 * and simply has no title.
 */
const titleFromUrl = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const createDuckduckgoProvider = ({
  maxResults,
  region,
  timeoutMs,
}: {
  maxResults?: number;
  region?: string;
  timeoutMs?: number;
} = {}): WebSearchProvider => {
  return createJsonSearchProvider({
    buildRequest: (query) => {
      const params = new URLSearchParams({
        format: 'json',
        // No result count: the endpoint returns the topics it knows about and
        // the provider's own cap trims that to the deployment's budget.
        kl: normalizeDuckduckgoRegion(region),
        no_html: '1',
        q: query,
        skip_disambig: '1',
      });

      return {
        init: { headers: { Accept: 'application/json' } },
        url: `${ENDPOINT}?${params.toString()}`,
      };
    },
    extractResults: (payload): WebSearchResult[] => {
      const results: WebSearchResult[] = [];
      const abstract =
        typeof payload.AbstractText === 'string' ? payload.AbstractText : '';
      const abstractUrl =
        typeof payload.AbstractURL === 'string' ? payload.AbstractURL : '';

      if (abstract && abstractUrl) {
        const heading =
          typeof payload.Heading === 'string' ? payload.Heading : '';

        results.push(
          asSearchResult({
            content: abstract,
            title: heading || titleFromUrl(abstractUrl),
            url: abstractUrl,
          }),
        );
      }

      flattenTopics(payload.RelatedTopics).forEach((topic) => {
        const url = typeof topic.FirstURL === 'string' ? topic.FirstURL : '';
        const text = typeof topic.Text === 'string' ? topic.Text : '';

        if (!url || !text) {
          return;
        }

        results.push(
          asSearchResult({ content: text, title: titleFromUrl(url), url }),
        );
      });

      return results;
    },
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    maxResults,
    timeoutMs,
  });
};
