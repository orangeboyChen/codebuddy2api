import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * The worker is a plain script in `public/`, so no bundler, type checker, or
 * linter looks at it — these tests are the only thing standing between a broken
 * worker and a console that silently stops being installable. It is executed
 * against stubs in a fresh context, which is also what keeps the stubs honest:
 * the worker only ever touches `self`, `caches`, and `fetch`.
 */
const workerSource = fs.readFileSync(path.join('public', 'sw.js'), 'utf8');

interface CacheStub {
  delete: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

interface WorkerHarness {
  caches: {
    delete: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  };
  clients: { claim: ReturnType<typeof vi.fn> };
  dispatch: (type: string, event: unknown) => void;
  fetch: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
}

const makeResponse = (status: number, type = 'basic') => {
  return {
    clone: () => makeResponse(status, type),
    status,
    type,
  };
};

const loadWorker = (options: {
  cache?: Partial<CacheStub>;
  cacheNames?: string[];
  fetchResponse?: unknown;
  openCache?: () => Promise<CacheStub>;
}): WorkerHarness => {
  const cache: CacheStub = {
    delete: vi.fn().mockResolvedValue(true),
    keys: vi.fn().mockResolvedValue([]),
    match: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    ...options.cache,
  };
  const caches = {
    delete: vi.fn().mockResolvedValue(true),
    keys: vi
      .fn()
      .mockResolvedValue(options.cacheNames ?? ['codebuddy2api-shell-v1']),
    open: vi.fn().mockImplementation(async () => {
      if (options.openCache) {
        return options.openCache();
      }

      if (options.cache) {
        return cache;
      }

      throw new Error('cache storage unavailable');
    }),
  };
  const clients = { claim: vi.fn().mockResolvedValue(undefined) };
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const workerSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    clients,
    location: { origin: 'https://console.test' },
    skipWaiting: vi.fn(),
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(options.fetchResponse ?? makeResponse(200));

  vm.runInNewContext(workerSource, {
    caches,
    fetch,
    self: workerSelf,
    URL,
  });

  return {
    caches,
    clients,
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    fetch,
    skipWaiting: workerSelf.skipWaiting,
  };
};

/** Minimal stand-in for `FetchEvent`: records whether the worker took over. */
const makeFetchEvent = (url: string, method = 'GET') => {
  const event: {
    request: { method: string; url: string };
    respondWith: ReturnType<typeof vi.fn>;
    response?: unknown;
  } = {
    request: { method, url },
    respondWith: vi.fn((value: Promise<unknown>) => {
      event.response = value;
    }),
  };

  return event;
};

const settled = async (value: Promise<unknown>) => {
  return value.catch(() => undefined);
};

describe('service worker', () => {
  it('serves a cached build asset without touching the network', async () => {
    const cached = makeResponse(200);
    const worker = loadWorker({
      cache: { match: vi.fn().mockResolvedValue(cached) },
    });
    const event = makeFetchEvent(
      'https://console.test/_next/static/chunks/a.js',
    );

    worker.dispatch('fetch', event);
    await settled(event.response as Promise<unknown>);

    await expect(event.response).resolves.toBe(cached);
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it('caches a build asset it had to fetch', async () => {
    const cache: CacheStub = {
      delete: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const worker = loadWorker({ cache });
    const event = makeFetchEvent(
      'https://console.test/_next/static/css/app.css',
    );

    worker.dispatch('fetch', event);
    const response = await settled(event.response as Promise<unknown>);

    expect(response).toBeTruthy();
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0][0]).toEqual(event.request);
  });

  it('leaves every request outside the build assets to the browser', async () => {
    const worker = loadWorker({});

    for (const event of [
      makeFetchEvent('https://console.test/dashboard'),
      makeFetchEvent('https://console.test/admin-api/credentials'),
      makeFetchEvent('https://console.test/_next/static/chunks/a.js', 'POST'),
    ]) {
      worker.dispatch('fetch', event);
      expect(event.respondWith).not.toHaveBeenCalled();
    }

    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it('falls back to the network when cache storage is unavailable', async () => {
    const response = makeResponse(200);
    const worker = loadWorker({ fetchResponse: response });
    const event = makeFetchEvent(
      'https://console.test/_next/static/chunks/a.js',
    );

    worker.dispatch('fetch', event);

    await expect(event.response).resolves.toBe(response);
  });

  it('does not store a response that is not a plain 200', async () => {
    const cache: CacheStub = {
      delete: vi.fn(),
      keys: vi.fn().mockResolvedValue([]),
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };

    for (const fetchResponse of [
      makeResponse(206),
      makeResponse(404),
      makeResponse(200, 'opaque'),
    ]) {
      const worker = loadWorker({ cache, fetchResponse });
      const event = makeFetchEvent(
        'https://console.test/_next/static/chunks/a.js',
      );

      worker.dispatch('fetch', event);
      await settled(event.response as Promise<unknown>);
    }

    expect(cache.put).not.toHaveBeenCalled();
  });

  it('caps the cache so deploys cannot grow it without bound', async () => {
    const keys = Array.from(
      { length: 305 },
      (_unused, index) => `key-${index}`,
    );
    const cache: CacheStub = {
      delete: vi.fn().mockResolvedValue(true),
      keys: vi.fn().mockResolvedValue(keys),
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const worker = loadWorker({ cache });
    const event = makeFetchEvent(
      'https://console.test/_next/static/chunks/a.js',
    );

    worker.dispatch('fetch', event);
    await settled(event.response as Promise<unknown>);

    expect(cache.delete).toHaveBeenCalledTimes(5);
    expect(cache.delete.mock.calls.map(([key]) => key)).toEqual(
      keys.slice(0, 5),
    );
  });

  it('claims clients and drops its own superseded caches on activate', async () => {
    const worker = loadWorker({
      cacheNames: [
        'codebuddy2api-shell-v1',
        'codebuddy2api-shell-v0',
        'some-other-library',
      ],
    });
    const event = { waitUntil: vi.fn() };

    worker.dispatch('activate', event);
    await settled(event.waitUntil.mock.calls[0][0] as Promise<unknown>);

    expect(worker.caches.delete).toHaveBeenCalledTimes(1);
    expect(worker.caches.delete).toHaveBeenCalledWith('codebuddy2api-shell-v0');
    expect(worker.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('takes over as soon as it installs', () => {
    const worker = loadWorker({});

    worker.dispatch('install', {});

    expect(worker.skipWaiting).toHaveBeenCalledTimes(1);
  });
});
