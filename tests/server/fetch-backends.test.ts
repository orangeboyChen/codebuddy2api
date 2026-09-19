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

/**
 * Stubs `fetch` with a queue of responses, recording every call.
 *
 * A queued `Response` is snapshotted on first use and rebuilt after that: a
 * response body can only be read once, and the last entry is replayed for every
 * later call.
 */
const stubFetchQueue = (
  responses: Array<Response | ((url: string) => Response)>,
): { calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const snapshots = new Map<
    number,
    { body: string; headers: Array<[string, string]>; status: number }
  >();
  let index = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const requestInit = (init ?? {}) as RequestInit;
      calls.push({ init: requestInit, url });
      const slot = Math.min(index, responses.length - 1);
      index += 1;

      const entry = responses[slot];

      if (typeof entry === 'function') {
        return entry(url);
      }

      let snapshot = snapshots.get(slot);

      if (!snapshot) {
        snapshot = {
          body: await entry.text(),
          headers: [...entry.headers],
          status: entry.status,
        };
        snapshots.set(slot, snapshot);
      }

      return new Response(snapshot.body, {
        headers: snapshot.headers,
        status: snapshot.status,
      });
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

    expect(calls[0].url).toBe(
      `https://r.jina.ai/${encodeURIComponent('https://example.com/post')}`,
    );
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
      `https://r.jina.ai/${encodeURIComponent('https://raw.githubusercontent.com/o/r/main/README.md')}`,
    );
  });

  it('keeps a query string part of the page it asks for', async () => {
    // Concatenating the target would turn `?q=` into Jina's own options and
    // silently read a different page.
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await createJinaFetchProvider().fetch({
      url: 'https://example.com/search?q=hello&page=2',
    });

    expect(new URL(calls[0].url).search).toBe('');
    expect(decodeURIComponent(new URL(calls[0].url).pathname)).toBe(
      '/https://example.com/search?q=hello&page=2',
    );
  });

  it('refuses a private or loopback address', async () => {
    // The model supplies the URL, so a remote fetcher must not be handed one
    // that only means something inside the deployment's own network.
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await expect(
      createJinaFetchProvider().fetch({ url: 'http://169.254.169.254/latest' }),
    ).rejects.toThrow('private or loopback address');
    await expect(
      createJinaFetchProvider().fetch({ url: 'http://127.0.0.1:8001/admin' }),
    ).rejects.toThrow('private or loopback address');
    expect(calls).toEqual([]);
  });

  it('refuses a URL that is not absolute', async () => {
    stubFetchQueue([makeTextResponse('text')]);

    await expect(
      createJinaFetchProvider().fetch({ url: 'example.com/post' }),
    ).rejects.toThrow('not a valid absolute URL');
  });

  it('refuses a fetch with no URL at all', async () => {
    stubFetchQueue([makeTextResponse('text')]);

    await expect(createJinaFetchProvider().fetch({ url: '' })).rejects.toThrow(
      'without a URL',
    );
  });

  it('turns an HTTP failure into an error the model can read', async () => {
    stubFetchQueue([makeTextResponse('nope', 429)]);

    await expect(
      createJinaFetchProvider().fetch({ url: 'https://example.com' }),
    ).rejects.toThrow('Jina Reader failed with HTTP 429');
  });

  it('caps the text it hands back', async () => {
    stubFetchQueue([makeTextResponse('x'.repeat(200_000))]);

    const result = await createJinaFetchProvider().fetch({
      url: 'https://example.com',
    });

    // The page text is capped at 100k; the surrounding lines are a few dozen
    // characters, so the result cannot be much longer than the cap.
    expect(result.content.length).toBeGreaterThan(100_000);
    expect(result.content.length).toBeLessThan(100_500);
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
      // The result path answers "running" twice before it completes, so the
      // assertion fails unless the polling loop really iterates.
      let polls = 0;
      const { calls } = stubFetchQueue([
        makeJsonResponse({ task_id: 'task-9' }),
        (url: string) => {
          if (!url.endsWith('/result')) {
            // The task path is not served by this deployment.
            return makeJsonResponse(null, 404);
          }

          polls += 1;

          return polls < 3
            ? makeJsonResponse({ status: 'running' })
            : makeJsonResponse({
                status: 'completed',
                output: 'Finished text',
              });
        },
      ]);

      const pending = createBrowserableProvider({
        url: 'http://browser.test',
      }).fetch({ url: 'https://example.com' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(polls).toBe(3);
      expect(calls.filter((call) => call.url.endsWith('/result'))).toHaveLength(
        3,
      );
      expect(result.content).toContain('Finished text');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a task that finished with no text as a failure', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      stubFetchQueue([
        makeJsonResponse({ id: 'task-9' }),
        (url: string) => {
          if (!url.endsWith('/result')) {
            return makeJsonResponse(null, 404);
          }

          polls += 1;

          return makeJsonResponse({ status: 'completed', output: '' });
        },
      ]);

      const outcome = createBrowserableProvider({ url: 'http://browser.test' })
        .fetch({ url: 'https://example.com' })
        .catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(10_000);

      // An empty page is a failed fetch, as it is for the local backend, so a
      // chain moves on to the next backend instead of stopping here.
      expect(polls).toBe(1);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining('finished without returning any text'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a deployment that reports completion without a status', async () => {
    vi.useFakeTimers();
    try {
      stubFetchQueue([
        makeJsonResponse({ id: 'task-9' }),
        (url: string) =>
          url.endsWith('/result')
            ? makeJsonResponse({ done: true, output: 'Done text' })
            : makeJsonResponse(null, 404),
      ]);

      const pending = createBrowserableProvider({
        url: 'http://browser.test',
      }).fetch({ url: 'https://example.com' });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.content).toContain('Done text');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an IPv4-mapped IPv6 address to a private host', async () => {
    const { calls } = stubFetchQueue([
      makeJsonResponse({ output: 'text' }),
      makeTextResponse('text'),
    ]);

    await expect(
      createBrowserableProvider({ url: 'http://browser.test' }).fetch({
        url: 'http://[::ffff:127.0.0.1]:8001/admin',
      }),
    ).rejects.toThrow('private or loopback address');
    await expect(
      createJinaFetchProvider().fetch({
        url: 'http://[::ffff:169.254.169.254]/',
      }),
    ).rejects.toThrow('private or loopback address');
    expect(calls).toEqual([]);
  });

  it('refuses a private or loopback address', async () => {
    const { calls } = stubFetchQueue([makeJsonResponse({ output: 'text' })]);

    await expect(
      createBrowserableProvider({ url: 'http://browser.test' }).fetch({
        url: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow('private or loopback address');
    expect(calls).toEqual([]);
  });

  it('refuses a fetch with no URL at all', async () => {
    stubFetchQueue([makeJsonResponse({ output: 'text' })]);

    await expect(
      createBrowserableProvider({ url: 'http://browser.test' }).fetch({
        url: '  ',
      }),
    ).rejects.toThrow('without a URL');
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

describe('the registry hands each backend its console settings', () => {
  it('sends the Jina key entered in the console', async () => {
    const { calls } = stubFetchQueue([makeTextResponse('text')]);

    await resolveFetchProvider('jina', {
      fetch: { jinaApiKey: 'from-console' },
    })?.fetch({ url: 'https://example.com' });

    expect(headersOf(calls[0].init).get('Authorization')).toBe(
      'Bearer from-console',
    );
  });

  it('sends the Browserable key and address entered in the console', async () => {
    const { calls } = stubFetchQueue([makeJsonResponse({ output: 'text' })]);

    await resolveFetchProvider('browserable', {
      fetch: {
        browserableApiKey: 'from-console',
        browserableUrl: 'http://browser.test',
      },
    })?.fetch({ url: 'https://example.com' });

    expect(calls[0].url).toBe('http://browser.test/tasks');
    expect(headersOf(calls[0].init).get('x-api-key')).toBe('from-console');
  });

  it('drops a Browserable address that is not absolute', () => {
    expect(
      resolveFetchProvider('browserable', {
        fetch: { browserableUrl: 'browser.test:8000' },
      }),
    ).toBeNull();
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
