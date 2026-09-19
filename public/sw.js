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
const CACHED_ASSET_PREFIXES = ['/_next/static/'];

const isCacheableAsset = (url) => {
  try {
    const { pathname } = new URL(url, self.location.origin);

    return CACHED_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  } catch {
    return false;
  }
};

self.addEventListener('install', () => {
  // Take over as soon as the worker is active so a rebuilt console does not
  // keep serving through the previous worker until every tab is closed.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
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
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      if (cached) {
        return cached;
      }

      const response = await fetch(request);

      if (response.ok && response.type === 'basic') {
        cache.put(request, response.clone());
      }

      return response;
    })(),
  );
});
