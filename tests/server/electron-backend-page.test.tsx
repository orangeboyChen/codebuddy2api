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
 * The window the desktop opens for a backend, rendered the way it is in the app:
 * a page that mounts itself into `#root` and asks the main process for
 * everything it shows.
 *
 * What these cover is the regression that left the window blank — `Tabs` reads
 * its motion out of `ConfigProvider` and throws without one, and the throw took
 * the whole tree down, so the window came up empty with nothing in the log the
 * page could have told anyone about — and then the whole of what the window
 * does: which backend the app should show data from, and what it does with the
 * answer.
 */
const DEFAULTS = {
  appVersion: '1.4.0',
  backend: { mode: 'local' } as
    | { mode: 'local'; url?: string }
    | {
        mode: 'remote';
        url: string;
      },
  firstRun: false,
  homePage: 'https://github.com/orangeboyChen/codebuddy2api',
  locale: 'zh-CN',
  maxPort: 65535,
  minPort: 1024,
  port: 8001,
};

interface MountOptions {
  backend?: typeof DEFAULTS.backend;
  firstRun?: boolean;
  port?: number;
  portInUse?: { message: string; port: string } | null;
  screen?: 'choose' | 'portInUse' | 'settings' | 'unreachable';
  serverVersion?: string | null;
  unreachable?: { host: string; message: string } | null;
}

const info = (options: MountOptions) => ({
  ...DEFAULTS,
  ...options,
  backend: options.backend ?? DEFAULTS.backend,
  text: desktopText('zh-CN'),
});

const bridge = () => ({
  getInfo: vi.fn(),
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

const mount = async (options: MountOptions = {}) => {
  document.body.innerHTML = '<div id="root"></div>';
  stubMatchMedia();

  const next = bridge();

  next.getInfo.mockResolvedValue(info(options));
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: next,
    writable: true,
  });
  vi.resetModules();

  // The page mounts itself on import, so the import is the render — wrapped,
  // because the main process's answer lands in a state update after it.
  await act(async () => {
    await import('@/electron/backend');
  });

  return next;
};

/** The radio of one of the two backends: this machine's, or a deployment. */
const pickMode = async (mode: 'local' | 'remote'): Promise<void> => {
  const radio = document.querySelector<HTMLInputElement>(
    `input[value="${mode}"]`,
  );

  expect(radio).not.toBeNull();
  await act(async () => {
    fireEvent.click(radio as HTMLInputElement);
  });
};

const type = async (id: string, value: string): Promise<void> => {
  const field = document.getElementById(id) as HTMLInputElement;

  expect(field).not.toBeNull();
  await act(async () => {
    fireEvent.change(field, { target: { value } });
  });
};

const save = async (): Promise<void> => {
  const button = document.getElementById('save') as HTMLButtonElement;

  expect(button).not.toBeNull();
  await act(async () => {
    fireEvent.click(button);
  });
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the backend screen', () => {
  it('still renders the question it asks on a first launch', async () => {
    await mount({ firstRun: true });

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    // A first launch that is answered with nothing has nothing to run, so the
    // way out is the app, not this window.
    expect(screen.getByText('保存')).toBeTruthy();
    expect(screen.getByText('退出')).toBeTruthy();
    expect(screen.queryByText('取消')).toBeNull();
  });

  it('offers closing the window rather than the app once there is a backend', async () => {
    await mount({ firstRun: false });

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    expect(screen.getByText('取消')).toBeTruthy();
    expect(screen.queryByText('退出')).toBeNull();
  });

  it('saves a deployment by its address, and no port of this machine', async () => {
    const next = await mount();

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    // A deployment is reached through its address, so naming one is the whole
    // answer: the port the console is served on is left standing.
    await pickMode('remote');
    await type('url', 'https://deploy.example.com');
    await save();

    expect(next.setBackend).toHaveBeenCalledWith({
      backend: { mode: 'remote', url: 'https://deploy.example.com/' },
    });
  });

  it('refuses an address that is not one', async () => {
    const next = await mount();

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    await pickMode('remote');
    await type('url', 'deploy.example.com');
    await save();

    expect(
      screen.getByText('请输入以 http:// 或 https:// 开头的地址'),
    ).toBeTruthy();
    expect(next.setBackend).not.toHaveBeenCalled();
  });

  it('saves the port this machine serves its own console on', async () => {
    const next = await mount();

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    await type('port', '8123');
    await save();

    expect(next.setBackend).toHaveBeenCalledWith({
      backend: { mode: 'local' },
      port: 8123,
    });
  });

  it('refuses a port it could not bind', async () => {
    const next = await mount();

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    // Below the floor the main process named, and then not a number at all:
    // what is saved is what the gateway binds, so both are put right here.
    await type('port', '80');
    await save();

    expect(screen.getByText('请输入 1024 到 65535 之间的整数。')).toBeTruthy();
    expect(next.setBackend).not.toHaveBeenCalled();

    await type('port', ' eighty');
    await save();

    expect(next.setBackend).not.toHaveBeenCalled();
  });

  it('asks about a port of this machine only while this machine is the backend', async () => {
    await mount();

    await waitFor(() => {
      expect(screen.getByText('选择后端')).toBeTruthy();
    });

    expect(screen.getByLabelText('端口')).toBeTruthy();

    await pickMode('remote');

    // The address is the whole answer for a deployment, so the port it does not
    // settle is not asked about.
    expect(screen.queryByLabelText('端口')).toBeNull();
    expect(document.getElementById('url')).not.toBeNull();
  });
});

describe('the settings screen', () => {
  it('renders both tabs instead of an empty window', async () => {
    await mount({ screen: 'settings' });

    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '后端',
      '关于',
    ]);
  });

  it('puts the port field and the save button in the backend tab', async () => {
    await mount({ screen: 'settings' });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '后端' })).toBeTruthy();
    });

    // The port alone: this machine is the backend, so there is no address to
    // ask for.
    expect(screen.getByLabelText('端口')).toBeTruthy();
    expect(screen.queryByLabelText(/地址/)).toBeNull();
    expect(screen.getByText('保存')).toBeTruthy();
  });

  it('asks for the address of a deployment whose data it shows', async () => {
    const next = await mount({
      backend: { mode: 'remote', url: 'https://deploy.example.com' },
      screen: 'settings',
    });

    await waitFor(() => {
      expect(screen.getByLabelText('地址')).toBeTruthy();
    });

    expect(screen.queryByLabelText('端口')).toBeNull();

    await type('url', 'https://other.example.com/console');
    await save();

    expect(next.setBackend).toHaveBeenCalledWith({
      backend: { mode: 'remote', url: 'https://other.example.com/console' },
    });
  });

  it('asks for a port again when the backend becomes this machine', async () => {
    const next = await mount({
      backend: { mode: 'remote', url: 'https://deploy.example.com' },
      screen: 'settings',
    });

    await waitFor(() => {
      expect(screen.getByLabelText('地址')).toBeTruthy();
    });

    await pickMode('local');

    expect(screen.getByLabelText('端口')).toBeTruthy();
    expect(screen.queryByLabelText('地址')).toBeNull();

    await type('port', '8123');
    await save();

    expect(next.setBackend).toHaveBeenCalledWith({
      backend: { mode: 'local' },
      port: 8123,
    });
  });

  it('says what the app is on the other tab', async () => {
    await mount({ screen: 'settings' });

    const about = await waitFor(() =>
      screen.getByRole('tab', { name: '关于' }),
    );

    // Only the tab being looked at is in the document, so the other one has to
    // be opened before there is anything of it to read.
    await act(async () => {
      fireEvent.click(about);
    });

    expect(await screen.findByText('版本 1.4.0')).toBeTruthy();
    // This machine's own gateway is this app, so there is no second build to
    // name a version for.
    expect(screen.queryByText(/服务端版本/)).toBeNull();
    expect(screen.getByText('后端: 本机')).toBeTruthy();
  });

  it('names the deployment it is showing data from', async () => {
    await mount({
      backend: { mode: 'remote', url: 'https://deploy.example.com' },
      screen: 'settings',
      serverVersion: '1.3.0',
    });

    const about = await waitFor(() =>
      screen.getByRole('tab', { name: '关于' }),
    );

    await act(async () => {
      fireEvent.click(about);
    });

    expect(await screen.findByText('服务端版本 1.3.0')).toBeTruthy();
    expect(screen.getByText('后端: 我自己部署的服务')).toBeTruthy();
  });
});

describe('the port that was taken', () => {
  it('asks for another one, and offers trying the old one again', async () => {
    const next = await mount({
      port: 8001,
      portInUse: { message: '已被其它程序占用。', port: '8001' },
      screen: 'portInUse',
    });

    await waitFor(() => {
      expect(screen.getByText('端口 8001 已被占用')).toBeTruthy();
    });

    // The main process filled the port it could not have into the field, so it
    // is the one on offer rather than a blank to fill in.
    expect(screen.getByText('已被其它程序占用。')).toBeTruthy();
    expect((document.getElementById('port') as HTMLInputElement).value).toBe(
      '8001',
    );

    await act(async () => {
      fireEvent.click(screen.getByText('重试'));
    });

    expect(next.retryBackend).toHaveBeenCalled();

    await type('port', '8123');
    await save();

    expect(next.setBackend).toHaveBeenCalledWith({
      backend: { mode: 'local' },
      port: 8123,
    });
  });
});

describe('the deployment that could not be used', () => {
  it('says so, and offers every way out of it', async () => {
    const next = await mount({
      screen: 'unreachable',
      unreachable: { host: 'deploy.example.com', message: '没有响应。' },
    });

    await waitFor(() => {
      expect(screen.getByText('无法使用这个服务')).toBeTruthy();
    });

    expect(screen.getByText('没有响应。')).toBeTruthy();

    // The address was wrong, or the deployment is down: each is a way out, and
    // only one of them is a way back into this window.
    await act(async () => {
      fireEvent.click(screen.getByText('在浏览器中打开'));
    });

    expect(next.openInBrowser).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('重试'));
    });

    expect(next.retryBackend).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('切换后端…'));
    });

    expect(await screen.findByText('选择后端')).toBeTruthy();
  });
});
