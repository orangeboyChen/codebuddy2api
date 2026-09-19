/**
 * Helpers shared by the server-tool backends.
 *
 * Result rendering, length clamping and environment parsing are identical for
 * every backend, so the model sees one consistent shape no matter which one
 * ran. Backends differ only in how they obtain their results.
 */

import type { WebSearchResult } from './types';

export const MAX_TITLE_LENGTH = 200;
export const MAX_SNIPPET_LENGTH = 800;

/** Reads an environment variable as a trimmed string, defaulting to empty. */
export const readEnv = (name: string): string => {
  const value = process.env[name];

  return typeof value === 'string' ? value.trim() : '';
};

/**
 * Parses an integer setting, falling back rather than throwing: a mistyped
 * environment value should degrade to a sane bound instead of disabling the
 * backend at startup.
 */
export const clampInteger = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw.trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
};

/** Collapses whitespace and truncates, so one long line cannot dominate the prompt. */
export const collapse = (value: string, maxLength: number): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();

  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
};

/**
 * Renders search hits as the text the model receives.
 *
 * The trailing instruction matters: without it a model that found nothing
 * useful tends to answer from memory and present it as if it were sourced.
 */
export const formatSearchResults = (
  query: string,
  results: WebSearchResult[],
): string => {
  if (!results.length) {
    return `Web search for "${query}" returned no results. Answer from your own knowledge and say that the search found nothing.`;
  }

  // Output size is already bounded: at most MAX_MAX_RESULTS entries, each with
  // its snippet truncated to MAX_SNIPPET_LENGTH.
  const lines: string[] = [
    `Web search results for "${query}" (${results.length} result${results.length === 1 ? '' : 's'}):`,
    '',
  ];

  results.forEach((result, index) => {
    const title = result.title?.trim() || '(untitled)';
    const url = result.url?.trim() ?? '';
    const snippet = result.content?.trim() ?? '';

    lines.push(`${index + 1}. ${title}`);

    if (url) {
      lines.push(`   URL: ${url}`);
    }

    if (snippet) {
      lines.push(`   ${snippet}`);
    }

    lines.push('');
  });

  lines.push(
    'Cite the URL of any result you rely on. If the results do not answer the question, say so instead of guessing.',
  );

  return lines.join('\n');
};

/**
 * Renders fetched page content as the text the model receives.
 *
 * A fetch has no citation list to append, but the source still has to be
 * named — otherwise the model has no URL to cite even though it read one.
 */
export const formatFetchResult = ({
  content,
  prompt,
  url,
}: {
  content: string;
  prompt?: string;
  url: string;
}): string => {
  const lines: string[] = [`Web fetch result for ${url}:`, ''];

  if (prompt) {
    lines.push(`Requested focus: ${collapse(prompt, MAX_TITLE_LENGTH)}`, '');
  }

  lines.push(content);

  return lines.join('\n');
};

/**
 * Reads a response body into text, stopping at `cap` characters.
 *
 * The URL a fetch follows comes from the model, so the body length is not the
 * deployment's to choose: a page that is merely enormous would otherwise be
 * buffered whole before anything could trim it. Reading with a ceiling and
 * cancelling the stream is what keeps an unbounded response from becoming an
 * unbounded allocation.
 */
export const readCappedResponseBody = async (
  response: Response,
  cap: number,
): Promise<string> => {
  const body = response.body;

  // No stream to read from (a stubbed response, or a body already consumed):
  // fall back to the whole body, still bounded by the cap.
  if (!body) {
    return (await response.text()).slice(0, cap);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      text += decoder.decode(value, { stream: true });

      if (text.length >= cap) {
        text = text.slice(0, cap);
        await reader.cancel();

        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return text;
};
