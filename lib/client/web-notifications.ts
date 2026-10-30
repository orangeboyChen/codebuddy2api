export const isWebNotificationSupported = (): boolean => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }

  const registration = globalThis.ServiceWorkerRegistration;

  return Boolean(
    ('serviceWorker' in navigator &&
      registration &&
      typeof registration.prototype.showNotification === 'function') ||
    typeof Notification === 'function',
  );
};

/**
 * Displays a native browser or installed-PWA notification.
 *
 * Mobile Safari does not support constructing `Notification` objects from a
 * page. Its Home Screen web apps use the Service Worker notification API
 * instead, so prefer that path whenever a registration is available.
 */
export const showWebNotification = async (
  title: string,
  body: string,
): Promise<boolean> => {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;

      if (typeof registration.showNotification === 'function') {
        await registration.showNotification(title, { body });
        return true;
      }
    } catch {
      // Fall through to the page notification API when the worker is not
      // available, for example in a browser that supports Notification but
      // blocks service workers.
    }
  }

  try {
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
};
