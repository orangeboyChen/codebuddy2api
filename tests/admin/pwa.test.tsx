// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';

import manifest from '@/app/manifest';
import PwaRegistrar from '@/app/pwa-registrar';
import { registerServiceWorker } from '@/lib/client/service-worker';

const setServiceWorker = (value: unknown): void => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value,
  });
};

const makeContainer = () => {
  return { register: vi.fn().mockResolvedValue('registration') };
};

const withProductionEnv = () => {
  vi.stubEnv('NODE_ENV', 'production');
};

/** Reads the width and height straight out of the PNG header (IHDR). */
const readPngSize = (filePath: string) => {
  const buffer = fs.readFileSync(filePath);

  expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG');

  return {
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  };
};

describe('registerServiceWorker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the worker with an app-wide scope', async () => {
    withProductionEnv();
    const container = makeContainer();
    setServiceWorker(container);

    await expect(registerServiceWorker()).resolves.toBe('registration');
    expect(container.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('stays out of the way outside a production build', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const container = makeContainer();
    setServiceWorker(container);

    await expect(registerServiceWorker()).resolves.toBeNull();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('resolves to null when the browser has no service worker', async () => {
    withProductionEnv();
    setServiceWorker(undefined);

    await expect(registerServiceWorker()).resolves.toBeNull();
  });

  it('swallows a rejected registration', async () => {
    withProductionEnv();
    const container = { register: vi.fn().mockRejectedValue(new Error('tls')) };
    setServiceWorker(container);

    await expect(registerServiceWorker()).resolves.toBeNull();
  });
});

describe('PwaRegistrar', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers on mount without rendering anything', async () => {
    withProductionEnv();
    const container = makeContainer();
    setServiceWorker(container);
    const { container: rendered } = render(<PwaRegistrar />);

    await vi.waitFor(() => {
      expect(container.register).toHaveBeenCalledTimes(1);
    });
    expect(rendered.innerHTML).toBe('');
  });
});

describe('web app manifest', () => {
  it('describes the console as an installable standalone app', () => {
    const value = manifest();

    expect(value).toMatchObject({
      display: 'standalone',
      name: 'CodeBuddy2API',
      scope: '/',
      short_name: 'CB2API',
      start_url: '/dashboard',
    });
  });

  it('declares a maskable icon alongside the plain ones', () => {
    const icons = manifest().icons ?? [];

    expect(icons).toHaveLength(3);
    expect(icons.filter((icon) => icon.purpose === 'maskable')).toHaveLength(1);
  });

  it('ships an icon file at every declared size', () => {
    const icons = manifest().icons ?? [];

    // Guard the loop: without this the test would pass on an empty list.
    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      const [width, height] = (icon.sizes ?? '')
        .split('x')
        .map((value) => Number.parseInt(value, 10));

      expect(readPngSize(path.join('public', icon.src))).toEqual({
        height,
        width,
      });
    }
  });

  it('ships a full-bleed iOS home screen icon', () => {
    expect(readPngSize('app/apple-icon.png')).toEqual({
      height: 180,
      width: 180,
    });
  });
});
