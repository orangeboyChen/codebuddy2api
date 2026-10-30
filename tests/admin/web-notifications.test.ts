// @vitest-environment jsdom

import {
  isWebNotificationSupported,
  showWebNotification,
} from '@/lib/client/web-notifications';

const setNotification = (value: unknown): void => {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value,
  });
};

const setServiceWorker = (value: unknown): void => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value,
  });
};

describe('web notifications', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'Notification');
    Reflect.deleteProperty(navigator, 'serviceWorker');
    Reflect.deleteProperty(globalThis, 'ServiceWorkerRegistration');
  });

  it('uses the service worker notification API for installed PWAs', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    class Registration {
      showNotification(...args: [string, NotificationOptions]): Promise<void> {
        return showNotification(...args);
      }
    }
    const registration = new Registration();

    Object.defineProperty(globalThis, 'ServiceWorkerRegistration', {
      configurable: true,
      value: Registration,
    });
    setNotification({ permission: 'granted' });
    setServiceWorker({ ready: Promise.resolve(registration) });

    expect(isWebNotificationSupported()).toBe(true);
    await expect(showWebNotification('Title', 'Body')).resolves.toBe(true);
    expect(showNotification).toHaveBeenCalledWith('Title', { body: 'Body' });
  });

  it('falls back to the page notification API when no worker is available', async () => {
    const constructor = vi.fn();
    setNotification(Object.assign(constructor, { permission: 'granted' }));

    expect(isWebNotificationSupported()).toBe(true);
    await expect(showWebNotification('Title', 'Body')).resolves.toBe(true);
    expect(constructor).toHaveBeenCalledWith('Title', { body: 'Body' });
  });

  it('does not notify without permission', async () => {
    const constructor = vi.fn();
    setNotification(Object.assign(constructor, { permission: 'default' }));

    await expect(showWebNotification('Title', 'Body')).resolves.toBe(false);
    expect(constructor).not.toHaveBeenCalled();
  });
});
