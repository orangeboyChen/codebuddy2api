// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopText } from '@/lib/server/electron/desktop-text';

/**
 * A mount here is the page's own module graph — antd, and `@lobehub/ui` with
 * it — loaded into a registry `vi.resetModules()` has just emptied, so every
 * one of them is a first import. That runs past the fifteen seconds the rest of
 * the suite is given when the other files are being transformed at the same
 * time.
 */
vi.setConfig({ testTimeout: 60_000 });

/**
 * The window the desktop opens for the settings, rendered the way it is in the
 * app: a page that mounts itself into `#root` and asks the main process for
 * everything it shows.
 *
 * What these cover is the regression that left the window blank — `Tabs` reads
 * its motion out of `ConfigProvider` and throws without one, and the throw took
 * the whole tree down, so the window came up empty with nothing in the log the
 * page could have told anyone about.
 */
const info = (screenName: 'choose' | 'settings') => {
  const text = desktopText('zh-CN');

  return {
    appVersion: '1.4.0',
    backend: { mode: 'local' },
    firstRun: false,
    homePage: 'https://github.com/orangeboyChen/codebuddy2api',
    locale: 'zh-CN',
    maxPort: 65535,
    minPort: 1024,
    port: 8001,
    screen: screenName,
    text,
  };
};

const bridge = (screenName: 'choose' | 'settings') => ({
  getInfo: vi.fn(async () => info(screenName)),
  openHomePage: vi.fn(async () => undefined),
  openInBrowser: vi.fn(async () => undefined),
  retryBackend: vi.fn(async () => undefined),
  setBackend: vi.fn(async () => undefined),
  setContentSize: vi.fn(async () => undefined),
});

/**
 * What jsdom does not have and the real window does: the appearance the
 * computer is in, which the theme provider listens to for changes to.
 */
const stubMatchMedia = () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined,
    }),
    writable: true,
  });
};

const mount = async (screenName: 'choose' | 'settings') => {
  document.body.innerHTML = '<div id="root"></div>';
  stubMatchMedia();
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: bridge(screenName),
    writable: true,
  });
  vi.resetModules();

  // The page mounts itself on import, so the import is the render — wrapped,
  // because the main process's answer lands in a state update after it.
  await act(async () => {
    await import('@/electron/backend');
  });
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the settings screen', () => {
  it('renders both tabs instead of an empty window', async () => {
    await mount('settings');

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '后端',
      '关于',
    ]);
  });

  it('puts the port field and the save button in the backend tab', async () => {
    await mount('settings');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '后端' })).toBeTruthy();
    });

    // The port alone: this machine is the backend, so there is no address to
    // ask for.
    expect(screen.getByLabelText('端口')).toBeTruthy();
    expect(screen.queryByLabelText(/地址/)).toBeNull();
    expect(screen.getByText('保存')).toBeTruthy();
  });

  it('says what the app is on the other tab', async () => {
    await mount('settings');

    const about = await waitFor(() =>
      screen.getByRole('tab', { name: '关于' }),
    );

    // Only the tab being looked at is in the document, so the other one has to
    // be opened before there is anything of it to read.
    await act(async () => {
      fireEvent.click(about);
    });

    expect(await screen.findByText('版本 1.4.0')).toBeTruthy();
  });
});

describe('the backend screen', () => {
  it('still renders the question it asks on a first launch', async () => {
    await mount('choose');

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    expect(screen.getByText('保存')).toBeTruthy();
  });
});
