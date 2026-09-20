const SERVICE_WORKER_URL = '/sw.js';

/**
 * Registers the service worker that makes the console installable.
 *
 * Registration is a nice-to-have. A browser without service workers, a worker
 * blocked by policy, or a failed download must each leave the console working,
 * so every path resolves to `null` instead of surfacing an error.
 */
export const registerServiceWorker =
  async (): Promise<ServiceWorkerRegistration | null> => {
    // Dev serves unhashed assets from memory; caching those would pin a stale
    // bundle in place and make edits look like they did not apply.
    if (process.env.NODE_ENV !== 'production') {
      return null;
    }

    const container =
      typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;

    if (!container) {
      return null;
    }

    try {
      return await container.register(SERVICE_WORKER_URL, {
        scope: '/',
        updateViaCache: 'none',
      });
    } catch {
      return null;
    }
  };
