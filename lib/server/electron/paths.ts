import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DesktopPaths {
  credentialsDir: string;
  dataDir: string;
  keyFile: string;
  sqlitePath: string;
  userDataDir: string;
}

export interface GatewayDirOptions {
  appPath: string;
  /** Defaults to `fs.existsSync`, overridable so tests stay off the disk. */
  exists?: (candidate: string) => boolean;
  resourcesPath?: string;
}

export interface AppBundleDirOptions {
  appPath: string;
  /** Defaults to `fs.existsSync`, overridable so tests stay off the disk. */
  exists?: (candidate: string) => boolean;
}

const KEY_BYTES = 32;

/**
 * Everything the desktop app writes lives under the Electron `userData`
 * directory, next to the rest of the per-user application state. Nothing is
 * written next to the installed bundle, which is read-only and replaced
 * wholesale on every upgrade.
 */
export const resolveDesktopPaths = (userDataDir: string): DesktopPaths => {
  const dataDir = path.join(userDataDir, 'data');

  return {
    credentialsDir: path.join(userDataDir, 'credentials'),
    dataDir,
    keyFile: path.join(userDataDir, 'storage-encryption-key'),
    sqlitePath: path.join(dataDir, 'storage.sqlite'),
    userDataDir,
  };
};

export const ensureDesktopDirectories = (paths: DesktopPaths): void => {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.credentialsDir, { recursive: true });
};

/**
 * The desktop app runs on a database backend, which refuses to start without
 * `CODEBUDDY_STORAGE_ENCRYPTION_KEY`. There is no one to ask for a passphrase
 * on a desktop install, so one is generated on first launch and reused from
 * then on. Losing the file locks the stored credentials for good, which is the
 * same contract documented for self-hosted deployments.
 */
export const ensureDesktopEncryptionKey = (keyFile: string): string => {
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();

    if (existing) {
      return existing;
    }
  }

  const generated = crypto.randomBytes(KEY_BYTES).toString('hex');

  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });

  return generated;
};

/**
 * Where the app's own files sit: the tray icon, the preload script and the page
 * that asks which backend to use, all shipped next to `main.js`.
 *
 * Not `__dirname`, which the bundler freezes to the directory the bundle was
 * built in — a path that exists on the machine that ran the build and on no
 * other. A packaged app is handed the bundle itself, while `electron .` from a
 * checkout is handed the repository root, so the bundle is found by asking
 * which of the two holds it.
 */
export const resolveAppBundleDir = (options: AppBundleDirOptions): string => {
  const exists = options.exists ?? fs.existsSync;

  if (exists(path.join(options.appPath, 'main.js'))) {
    return options.appPath;
  }

  return path.join(options.appPath, 'build', 'electron-app');
};

/**
 * A packaged app carries the gateway as an extra resource next to the app
 * bundle; an unpackaged one (`electron .`) has no resources directory of its
 * own and reads the gateway out of the build directory.
 */
export const resolveGatewayDir = (options: GatewayDirOptions): string => {
  const exists = options.exists ?? fs.existsSync;
  const packaged = options.resourcesPath
    ? path.join(options.resourcesPath, 'gateway')
    : null;

  if (packaged && exists(path.join(packaged, 'server.js'))) {
    return packaged;
  }

  return path.join(options.appPath, 'build', 'bundle', 'gateway');
};
