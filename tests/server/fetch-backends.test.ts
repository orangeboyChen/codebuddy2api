/**
 * Coverage for the two new `web_fetch` backends and for the chain the console's
 * multi-selection composes.
 *
 * Both backends are remote services, so `fetch` is stubbed. Browserable is
 * asynchronous — create a task, then poll it — which is what the fake timers
 * are for: the real poll interval is two seconds per attempt.
 */

import { resolveFetchProvider } from '@/lib/server/search';
import { createBrowserableProvider } from '@/lib/server/search/providers/browserable';
import { createJinaFetchProvider } from '@/lib/server/search/providers/jina';

const makeJsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const makeTextResponse = (text: string, status = 200): Response =>
  new Response(text, { status });

interface FetchCall {
  init: RequestInit;
  url: string;
}

/** Stubs `fetch` with a queue of responses, recording every call. */
const stubFetchQueue = (
  responses: Array<Response | ((url: string) => Response)>,
): { calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  let index = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const requestInit = (init ?? {}) as RequestInit;
      calls.push({ init: requestInit, url });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;

      return typeof next === 'function' ? next(url) : next;
    }) as unknown as typeof fetch,
  );

  return { calls };
};

const headersOf = (init: RequestInit): Headers => new Headers(init.headers);

const bodyOf = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Jina Reader', () => {
  it('asks for markdown at the reader endpoint', async () => {
    const { calls } = stubFetchQueue([makeTextResponse('# Page')]);

    const result = await createJinaFetchProvider().fetch({
      url: 'https://example.com/post',
    });

    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com/post');
    expect(headersOf(calls[0].init).get('X-Return-Format')).toBe('markdown');
    expect(result.content).toContain('# Page');
    expect(result.url).toBe('https://example.com/post');
  });

  it('sends the key as a bearer token when one is configured', async () => {
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await createJinaFetchProvider({ apiKey: 'jina-key' }).fetch({
      url: 'https://example.com',
    });

    expect(headersOf(calls[0].init).get('Authorization')).toBe(
      'Bearer jina-key',
    );
  });

  it('sends no Authorization header without a key', async () => {
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await createJinaFetchProvider().fetch({ url: 'https://example.com' });

    expect(headersOf(calls[0].init).get('Authorization')).toBeNull();
  });

  it('normalizes the url the way the CodeBuddy backend does', async () => {
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await createJinaFetchProvider().fetch({
      url: 'http://github.com/o/r/blob/main/README.md',
    });

    expect(calls[0].url).toBe(
      'https://r.jina.ai/https://raw.githubusercontent.com/o/r/main/README.md',
    );
  });

  it('turns an HTTP failure into an error the model can read', async () => {
    stubFetchQueue([makeTextResponse('nope', 429)]);

    await expect(
      createJinaFetchProvider().fetch({ url: 'https://example.com' }),
    ).rejects.toThrow('Jina Reader failed with HTTP 429');
  });

  it('caps the text it hands back', async () => {
    // The floor on the cap is 1_000 characters, so a smaller request is raised
    // to it rather than honoured literally.
    stubFetchQueue([makeTextResponse('x'.repeat(20_000))]);

    const result = await createJinaFetchProvider({
      maxContentLength: 120,
    }).fetch({ url: 'https://example.com' });

    expect(result.content.length).toBeLessThan(2_000);
  });
});

describe('Browserable', () => {
  it('creates a task and reads a synchronous result', async () => {
    const { calls } = stubFetchQueue([
      makeJsonResponse({ id: 'task-1', output: 'Page text' }),
    ]);

    const result = await createBrowserableProvider({
      apiKey: 'b-key',
      url: 'http://browser.test/',
    }).fetch({ url: 'https://example.com', prompt: 'the price' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://browser.test/tasks');
    expect(calls[0].init.method).toBe('POST');
    expect(headersOf(calls[0].init).get('x-api-key')).toBe('b-key');
    // The model's extraction hint is what makes an agent worth its latency.
    expect(bodyOf(calls[0].init).task).toContain('the price');
    expect(result.content).toContain('Page text');
  });

  it('omits the key header when the deployment needs none', async () => {
    const { calls } = stubFetchQueue([makeJsonResponse({ output: 'text' })]);

    await createBrowserableProvider({ url: 'http://browser.test' }).fetch({
      url: 'https://example.com',
    });

    expect(headersOf(calls[0].init).get('x-api-key')).toBeNull();
    // A trailing slash in the address must not produce a double slash.
    expect(calls[0].url).toBe('http://browser.test/tasks');
  });

  it('polls the task until it reports a result', async () => {
    vi.useFakeTimers();
    try {
      stubFetchQueue([
        makeJsonResponse({ task_id: 'task-9' }),
        makeJsonResponse({ status: 'running' }),
        makeJsonResponse({ status: 'completed', output: 'Finished text' }),
      ]);

      const pending = createBrowserableProvider({
        url: 'http://browser.test',
      }).fetch({ url: 'https://example.com' });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(result.content).toContain('Finished text');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the task itself when there is no result path', async () => {
    vi.useFakeTimers();
    try {
      const { calls } = stubFetchQueue([
        makeJsonResponse({ id: 'task-9' }),
        makeJsonResponse(null, 404),
        makeJsonResponse({ status: 'succeeded', result: 'From the task' }),
      ]);

      const pending = createBrowserableProvider({
        url: 'http://browser.test',
      }).fetch({ url: 'https://example.com' });
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;

      expect(calls.map((call) => call.url)).toEqual([
        'http://browser.test/tasks',
        'http://browser.test/tasks/task-9/result',
        'http://browser.test/tasks/task-9',
      ]);
      expect(result.content).toContain('From the task');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the task ends in failure', async () => {
    vi.useFakeTimers();
    try {
      stubFetchQueue([
        makeJsonResponse({ id: 'task-9' }),
        makeJsonResponse({ status: 'failed' }),
      ]);

      const outcome = createBrowserableProvider({
        url: 'http://browser.test',
      })
        .fetch({ url: 'https://example.com' })
        .catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining('ended with status "failed"'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the task never finishes', async () => {
    vi.useFakeTimers();
    try {
      stubFetchQueue([
        makeJsonResponse({ id: 'task-9' }),
        makeJsonResponse({}),
      ]);

      const outcome = createBrowserableProvider({
        timeoutMs: 5_000,
        url: 'http://browser.test',
      })
        .fetch({ url: 'https://example.com' })
        .catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining('did not finish within 5000ms'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the deployment accepts the task but names no id', async () => {
    stubFetchQueue([makeJsonResponse({ ok: true })]);

    await expect(
      createBrowserableProvider({ url: 'http://browser.test' }).fetch({
        url: 'https://example.com',
      }),
    ).rejects.toThrow('returned no task id');
  });

  it('reports an HTTP failure on task creation', async () => {
    stubFetchQueue([makeJsonResponse({}, 500)]);

    await expect(
      createBrowserableProvider({ url: 'http://browser.test' }).fetch({
        url: 'https://example.com',
      }),
    ).rejects.toThrow('Browserable failed with HTTP 500');
  });
});

describe('the fetch chain', () => {
  const chain = () =>
    resolveFetchProvider('jina,browserable', {
      fetch: { browserableUrl: 'http://browser.test' },
    });

  it('falls through to the next backend when one fails', async () => {
    // Jina is refused, Browserable answers.
    stubFetchQueue([
      makeTextResponse('nope', 429),
      makeJsonResponse({ id: 'task-1', output: 'Page text' }),
    ]);

    const result = await chain()?.fetch({ url: 'https://example.com' });

    expect(result?.content).toContain('Page text');
  });

  it('logs the hops it gave up on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchQueue([
      makeTextResponse('nope', 429),
      makeJsonResponse({ id: 'task-1', output: 'Page text' }),
    ]);

    await chain()?.fetch({ url: 'https://example.com' });

    expect(warn).toHaveBeenCalledWith(
      '[CodeBuddy2API] Web fetch backend failed',
      expect.objectContaining({ backend: 'jina' }),
    );
  });

  it('reports the last failure when every backend fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetchQueue([makeTextResponse('nope', 429), makeJsonResponse({}, 500)]);

    await expect(
      chain()?.fetch({ url: 'https://example.com' }),
    ).rejects.toThrow('Browserable failed with HTTP 500');
  });
});
