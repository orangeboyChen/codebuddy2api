/**
 * Browserable backend — a self-hostable browser agent.
 *
 * The address is expected to be an absolute `http(s)` URL; the registry checks
 * that before building this, because a provider that cannot be built is one the
 * deployment should not advertise.
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
import { assertRemotelyFetchableUrl } from './local-fetch';
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
const MAX_PROMPT_LENGTH = 500;

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
  timeoutMs: requestedTimeoutMs,
  url,
}: {
  apiKey?: string;
  timeoutMs?: number;
  url: string;
}): WebFetchProvider => {
  const base = url.trim().replace(/\/+$/, '');
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
    budgetMs = timeoutMs,
  ): Promise<Record<string, unknown> | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);

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
   * `null` means "still running". A finished task reports `{ done: true }` even
   * when it produced no text — a page that renders to nothing is an answer, not
   * a reason to poll until the deadline and report a timeout. A terminal failure
   * throws, because retrying the same instruction will fail the same way.
   */
  const readTaskOutcome = async (
    id: string,
    budgetMs: number,
  ): Promise<{ content: string; done: boolean } | null> => {
    const encoded = encodeURIComponent(id);
    const paths = [`/tasks/${encoded}/result`, `/tasks/${encoded}`];

    for (const path of paths) {
      const payload = await requestJson(
        path,
        { method: 'GET' },
        true,
        budgetMs,
      );

      if (!payload) {
        continue;
      }

      const status = readStatus(payload);
      const output = readOutput(payload);

      if (SUCCESS_STATUSES.has(status)) {
        return { content: output, done: true };
      }

      if (TERMINAL_STATUSES.has(status)) {
        throw new Error(`Browserable task ${id} ended with status "${status}"`);
      }

      // No status field at all: content is the only signal available, so it is
      // taken as completion rather than waited past.
      if (output && !status) {
        return { content: output, done: true };
      }
    }

    return null;
  };

  const fetchPage = async ({
    prompt,
    url: rawUrl,
  }: WebFetchQuery): Promise<WebFetchResponse> => {
    // Refused before it is sent: the agent fetches from its own network, so the
    // model's URL has to be checked here as well as by the local backend.
    const target = assertRemotelyFetchableUrl(normalizeFetchUrl(rawUrl));
    const focus = prompt?.trim().slice(0, MAX_PROMPT_LENGTH) ?? '';
    // The prompt is the model's extraction hint, and it is what makes a browser
    // agent worth its latency: without it the agent has no idea what to return.
    const task = focus
      ? `Open ${target} and extract: ${focus}`
      : `Open ${target} and return the visible text of the page.`;

    const deadline = Date.now() + timeoutMs;
    /** Milliseconds left before the whole call has to give up. */
    const remaining = () => Math.max(deadline - Date.now(), MIN_TIMEOUT_MS);

    const created =
      (await requestJson(
        '/tasks',
        {
          body: JSON.stringify({ task, url: target }),
          method: 'POST',
        },
        false,
        remaining(),
      )) ?? {};

    // Some deployments finish synchronously, in which case there is nothing to
    // poll and no id to read.
    const immediate = readOutput(created);

    if (immediate) {
      return {
        content: formatFetchResult({
          content: immediate.slice(0, MAX_CONTENT_LENGTH),
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

    for (;;) {
      await sleep(Math.min(POLL_INTERVAL_MS, remaining()));

      // Each poll is bounded by the time left for the whole call, so a slow
      // deployment cannot stretch one fetch into several full timeouts.
      const outcome = await readTaskOutcome(id, remaining());

      if (outcome?.done) {
        return {
          content: formatFetchResult({
            content: outcome.content.slice(0, MAX_CONTENT_LENGTH),
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
