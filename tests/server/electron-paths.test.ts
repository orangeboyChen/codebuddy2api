import fs from 'node:fs';
import path from 'node:path';

import {
  ensureDesktopDirectories,
  ensureDesktopEncryptionKey,
  resolveAppBundleDir,
  resolveDesktopPaths,
  resolveGatewayDir,
} from '@/lib/server/electron/paths';

const root = path.join(process.cwd(), '.tmp-test-electron-paths');
const userData = path.join(root, 'user-data');

const resetRoot = (): void => {
  fs.rmSync(root, { force: true, recursive: true });
};

describe('resolveDesktopPaths', () => {
  it('keeps every writable path inside the userData directory', () => {
    const paths = resolveDesktopPaths(userData);

    expect(paths.dataDir).toBe(path.join(userData, 'data'));
    expect(paths.credentialsDir).toBe(path.join(userData, 'credentials'));
    expect(paths.sqlitePath).toBe(
      path.join(userData, 'data', 'storage.sqlite'),
    );
    expect(paths.keyFile).toBe(path.join(userData, 'storage-encryption-key'));
  });
});

describe('ensureDesktopDirectories', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('creates the data and credentials directories', () => {
    const paths = resolveDesktopPaths(userData);

    ensureDesktopDirectories(paths);

    expect(fs.statSync(paths.dataDir).isDirectory()).toBe(true);
    expect(fs.statSync(paths.credentialsDir).isDirectory()).toBe(true);
  });
});

describe('ensureDesktopEncryptionKey', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('generates a key on first launch and reuses it afterwards', () => {
    const keyFile = path.join(userData, 'storage-encryption-key');
    const first = ensureDesktopEncryptionKey(keyFile);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureDesktopEncryptionKey(keyFile)).toBe(first);
    // Credentials and access keys are encrypted with it, so it must not be
    // world-readable.
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('generates a key when the file exists but is empty', () => {
    const keyFile = path.join(userData, 'storage-encryption-key');

    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(keyFile, '  \n');

    expect(ensureDesktopEncryptionKey(keyFile)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('resolveAppBundleDir', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('takes the bundle directory a packaged app is handed', () => {
    const appPath = path.join(root, 'app.asar');

    fs.mkdirSync(appPath, { recursive: true });
    fs.writeFileSync(path.join(appPath, 'main.js'), '');

    expect(resolveAppBundleDir({ appPath })).toBe(appPath);
  });

  it('takes the build directory when the app path is a checkout', () => {
    const appPath = path.join(root, 'checkout');

    fs.mkdirSync(appPath, { recursive: true });
    fs.writeFileSync(path.join(appPath, 'package.json'), '{}');

    expect(resolveAppBundleDir({ appPath })).toBe(
      path.join(appPath, 'build', 'electron-app'),
    );
  });
});

describe('resolveGatewayDir', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('prefers the packaged gateway next to the app bundle', () => {
    const resourcesPath = path.join(root, 'resources');

    fs.mkdirSync(path.join(resourcesPath, 'gateway'), { recursive: true });
    fs.writeFileSync(path.join(resourcesPath, 'gateway', 'server.js'), '');

    expect(
      resolveGatewayDir({
        appPath: path.join(root, 'app'),
        resourcesPath,
      }),
    ).toBe(path.join(resourcesPath, 'gateway'));
  });

  it('falls back to the build directory when nothing is packaged', () => {
    const appPath = path.join(root, 'app');
    const buildGateway = path.join(appPath, 'build', 'bundle', 'gateway');

    expect(resolveGatewayDir({ appPath })).toBe(buildGateway);
    expect(
      resolveGatewayDir({
        appPath,
        resourcesPath: path.join(root, 'empty-resources'),
      }),
    ).toBe(buildGateway);
  });
});
