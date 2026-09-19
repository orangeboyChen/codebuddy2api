/**
 * Jina Reader backend.
 *
 * A hosted reader that returns a page as markdown, which is usually a better
 * prompt than the text this gateway can extract on its own: the HTML→text step
 * happens upstream, where tables, headings and links survive. It also reaches
 * pages that refuse a plain fetch, because the request comes from a real
 * browser rather than from the deployment's own address.
 *
 * The endpoint is usable without a key at a lower rate limit, which is why the
 * key is optional: a deployment can try the backend before paying for it.
 */

import { formatFetchResult } from '../shared';
import { normalizeFetchUrl } from './codebuddy-fetch';
import { assertRemotelyFetchableUrl } from './local-fetch';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
} from '../types';

const ENDPOINT = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONTENT_LENGTH = 100_000;

export const createJinaFetchProvider = ({
  apiKey,
  timeoutMs: requestedTimeoutMs,
}: {
  apiKey?: string;
  timeoutMs?: number;
} = {}): WebFetchProvider => {
  const timeoutMs = Math.min(
    Math.max(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  const fetchPage = async ({
    prompt,
    url,
  }: WebFetchQuery): Promise<WebFetchResponse> => {
    // Refused before it is sent: this backend fetches from Jina's network, so
    // the model's URL has to be checked here as well as by the local backend.
    const target = assertRemotelyFetchableUrl(normalizeFetchUrl(url));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = new Headers({
        Accept: 'text/markdown',
        'X-Return-Format': 'markdown',
      });

      if (apiKey) {
        headers.set('Authorization', `Bearer ${apiKey}`);
      }

      // Encoded, not concatenated: the target is a path segment, and leaving a
      // `?query` in it would be read as Jina's own options instead of as part
      // of the page to read.
      const response = await fetch(`${ENDPOINT}${encodeURIComponent(target)}`, {
        cache: 'no-store',
        headers,
        method: 'GET',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Jina Reader failed with HTTP ${response.status}`);
      }

      const content = (await response.text())
        .trim()
        .slice(0, MAX_CONTENT_LENGTH);

      return {
        content: formatFetchResult({ content, prompt, url: target }),
        url: target,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return { fetch: fetchPage, id: 'jina' };
};
