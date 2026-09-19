/**
 * Service worker for the admin console.
 *
 * Chromium browsers only offer to install a site that has a worker with a
 * `fetch` handler, so this one exists mainly to make the console installable.
 * It deliberately caches the least it can: build assets under `/_next/static/`
 * carry a content hash, so a cached copy is always the right copy, while every
 * other request — all authenticated admin traffic included — goes straight to
 * the network. The console is useless without its server, so pretending to
 * work offline would only hide a dead backend.
 */

const CACHE_NAME = 'codebuddy2api-shell-v1';
const CACHE_PREFIX = 'codebuddy2api-';
const CACHED_ASSET_PREFIXES = ['/_next/static/'];

/**
 * Ceiling on cached build assets.
 *
 * Every deploy adds a generation of hashed assets and nothing else ever
 * removes them, so an uncapped cache grows until the browser evicts the whole
 * origin — which can take the chunks an open console is still using with it.
 */
const MAX_CACHED_ENTRIES = 300;

const isCacheableAsset = (url) => {
  const { origin, pathname } = new URL(url, self.location.origin);

  // Same origin only: re-issuing someone else's asset from inside this worker
  // would serve it under the worker's own CSP, which forbids just that.
  return (
    origin === self.location.origin &&
    CACHED_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
};

const readCache = async (request) => {
  try {
    const cache = await caches.open(CACHE_NAME);

    return await cache.match(request);
  } catch {
    // Cache Storage can be missing outright — private windows, storage
    // blocking, a full disk. The worker must not turn that into a failed
    // request, so a cache miss is the safe answer.
    return undefined;
  }
};

const trimCache = async (cache) => {
  // `keys()` comes back in insertion order on every engine that matters, so
  // dropping from the front retires the oldest assets first.
  const keys = await cache.keys();
  const excess = keys.length - MAX_CACHED_ENTRIES;

  if (excess <= 0) {
    return;
  }

  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
};

const writeCache = async (request, response) => {
  try {
    const cache = await caches.open(CACHE_NAME);
    // Awaited rather than fired and forgotten: an unhandled rejection here
    // would be invisible, and a full cache has to be able to fail quietly.
    // Cloned because `put` consumes the body this handler still returns.
    await cache.put(request, response.clone());
    await trimCache(cache);
  } catch {
    // Caching is an optimisation; losing it must not cost the request.
  }
};

self.addEventListener('install', (event) => {
  // Take over as soon as the worker is active so a rebuilt console does not
  // keep serving through the previous worker until every tab is closed. Waited
  // on, or the install could settle — and the worker with it — first.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        // Only this app's caches: anything else on the origin belongs to
        // whichever library put it there.
        const stale = names.filter(
          (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
        );
        await Promise.all(stale.map((name) => caches.delete(name)));
      } catch {
        // Nothing to sweep if storage is unavailable — claiming clients below
        // still has to happen, or a promoted worker never takes over.
      }

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET' || !isCacheableAsset(request.url)) {
    // No `respondWith` leaves the browser to its default fetch.
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await readCache(request);

      if (cached) {
        return cached;
      }

      const response = await fetch(request);

      // `ok` would also accept a 206; a partial response cached under its bare
      // URL would then be replayed to later full requests.
      if (response.status === 200 && response.type === 'basic') {
        await writeCache(request, response);
      }

      return response;
    })(),
  );
});
