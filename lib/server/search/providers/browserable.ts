/**
 * Browserable backend — a self-hostable browser agent.
 *
 * The reason to pick it is reach: it drives a real browser, so pages that
 * refuse a plain fetch still come back — scripted pages, pages behind a login
 * the instance already holds, pages that block datacentre addresses. The cost
 * is latency, which is an order of magnitude worse than a direct fetch, so it
 * belongs in the middle or end of a fetch chain rather than at the front.
 *
 * The deployment needs an address; the API key is optional because a
 * self-hosted instance is commonly reachable without one.
 *
 * The exchange follows Browserable's REST API: create a task from an
 * instruction, then poll that task until it reports a result. Task ids and
 * result bodies are read from several field names, and the result is looked for
 * both on a task-specific path and on the task itself, because the API spells
 * both in more than one way across versions. A deployment whose paths differ
 * can be reached by giving its full address — any path prefix is kept as-is.
 */

import { asRecord } from '../../shared/content';
import { formatFetchResult } from '../shared';
import { normalizeFetchUrl } from './codebuddy-fetch';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
} from '../types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_CONTENT_LENGTH = 100_000;
const MIN_CONTENT_LENGTH = 1_000;
const MAX_PROMPT_LENGTH = 500;
const MAX_URL_LENGTH = 2_048;

const SUCCESS_STATUSES = new Set([
  'complete',
  'completed',
  'done',
  'finished',
  'success',
  'succeeded',
]);
const TERMINAL_STATUSES = new Set([
  ...SUCCESS_STATUSES,
  'canceled',
  'cancelled',
  'error',
  'failed',
  'failure',
]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** First non-empty string among the candidates, or `''`. */
const readFirstString = (values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
};

/**
 * The task id from a create-task response.
 *
 * Read from several spellings because the field has been named both `id` and
 * `task_id`, and has been returned both at the top level and nested under
 * `data` or `task_run`.
 */
const readTaskId = (payload: Record<string, unknown>): string => {
  const nested = asRecord(payload.data) ?? {};
  const run = asRecord(payload.task_run) ?? asRecord(payload.taskRun) ?? {};

  return readFirstString([
    payload.id,
    payload.taskId,
    payload.task_id,
    payload.runId,
    payload.run_id,
    nested.id,
    run.id,
  ]);
};

const readStatus = (payload: Record<string, unknown>): string => {
  const nested = asRecord(payload.data) ?? {};

  return readFirstString([payload.status, nested.status]).toLowerCase();
};

/**
 * The page text from a task result.
 *
 * `output` is the documented field, but it is not always a string — it is
 * sometimes an object carrying the text — so both shapes are read.
 */
const readOutput = (payload: Record<string, unknown>): string => {
  const nested = asRecord(payload.data) ?? {};
  const output = asRecord(payload.output) ?? asRecord(nested.output) ?? {};

  return readFirstString([
    payload.output,
    payload.result,
    payload.content,
    payload.text,
    nested.output,
    nested.result,
    nested.content,
    nested.text,
    output.content,
    output.result,
    output.text,
  ]);
};

export const createBrowserableProvider = ({
  apiKey,
  maxContentLength,
  timeoutMs: requestedTimeoutMs,
  url,
}: {
  apiKey?: string;
  maxContentLength?: number;
  timeoutMs?: number;
  url: string;
}): WebFetchProvider => {
  const base = url.trim().replace(/\/+$/, '');
  const limit = Math.min(
    Math.max(maxContentLength ?? MAX_CONTENT_LENGTH, MIN_CONTENT_LENGTH),
    MAX_CONTENT_LENGTH,
  );
  const timeoutMs = Math.min(
    Math.max(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS,
  );

  const buildHeaders = (): Headers => {
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });

    if (apiKey) {
      headers.set('x-api-key', apiKey);
    }

    return headers;
  };

  const requestJson = async (
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Headers },
    missingIsEmpty = false,
  ): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${base}${path}`, {
        cache: 'no-store',
        ...init,
        headers: buildHeaders(),
        signal: controller.signal,
      });

      if (response.status === 404 && missingIsEmpty) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Browserable failed with HTTP ${response.status}`);
      }

      const payload = await response.json().catch(() => null);

      return asRecord(payload) ?? {};
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * One poll of a running task, in both documented shapes.
   *
   * `null` means "still running"; a result means the task produced text; a
   * terminal failure throws, because retrying the same instruction will fail
   * the same way.
   */
  const readTaskOutcome = async (id: string): Promise<string | null> => {
    const encoded = encodeURIComponent(id);
    const paths = [`/tasks/${encoded}/result`, `/tasks/${encoded}`];

    for (const path of paths) {
      const payload = await requestJson(path, { method: 'GET' }, true);

      if (!payload) {
        continue;
      }

      const status = readStatus(payload);
      const output = readOutput(payload);

      if (SUCCESS_STATUSES.has(status)) {
        return output || null;
      }

      if (TERMINAL_STATUSES.has(status)) {
        throw new Error(`Browserable task ${id} ended with status "${status}"`);
      }

      // No status field at all: content is the only signal available, so it is
      // taken as completion rather than waited past.
      if (output && !status) {
        return output;
      }
    }

    return null;
  };

  const fetchPage = async ({
    prompt,
    url: rawUrl,
  }: WebFetchQuery): Promise<WebFetchResponse> => {
    const target = normalizeFetchUrl(rawUrl).slice(0, MAX_URL_LENGTH);
    const focus = prompt?.trim().slice(0, MAX_PROMPT_LENGTH) ?? '';
    // The prompt is the model's extraction hint, and it is what makes a browser
    // agent worth its latency: without it the agent has no idea what to return.
    const task = focus
      ? `Open ${target} and extract: ${focus}`
      : `Open ${target} and return the visible text of the page.`;

    const created =
      (await requestJson('/tasks', {
        body: JSON.stringify({ task, url: target }),
        method: 'POST',
      })) ?? {};

    // Some deployments finish synchronously, in which case there is nothing to
    // poll and no id to read.
    const immediate = readOutput(created);

    if (immediate) {
      return {
        content: formatFetchResult({
          content: immediate.slice(0, limit),
          prompt,
          url: target,
        }),
        url: target,
      };
    }

    const id = readTaskId(created);

    if (!id) {
      throw new Error(
        'Browserable accepted the task but returned no task id to poll.',
      );
    }

    const deadline = Date.now() + timeoutMs;

    for (;;) {
      await sleep(POLL_INTERVAL_MS);

      const outcome = await readTaskOutcome(id);

      if (outcome) {
        return {
          content: formatFetchResult({
            content: outcome.slice(0, limit),
            prompt,
            url: target,
          }),
          url: target,
        };
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Browserable task ${id} did not finish within ${timeoutMs}ms.`,
        );
      }
    }
  };

  return { fetch: fetchPage, id: 'browserable' };
};
