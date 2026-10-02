import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_GATEWAY_PORT,
  MAX_PORT,
  MIN_PORT,
  normalizePort,
  resolvePreferredPort,
} from './ports';

export { MAX_PORT, MIN_PORT };
/** The desktop name for the shared port parser in `ports`. */
export { normalizePort as normalizeDesktopPort };

export const DESKTOP_MODE_ENV = 'CODEBUDDY_DESKTOP';
export const DESKTOP_USER_DATA_ENV = 'CODEBUDDY_DESKTOP_USER_DATA_DIR';
export const DESKTOP_SETTINGS_FILENAME = 'desktop-settings.json';

/**
 * Where the console the app shows comes from.
 *
 * `local` is the gateway bundled into the app — started by the main process on
 * a loopback port, with its database inside `userData`. `remote` is a
 * deployment the user already runs: the desktop window opens that deployment
 * directly and does not start a local gateway.
 */
export type DesktopBackend =
  { mode: 'local' } | { mode: 'remote'; url: string };

export interface DesktopSettings {
  backend: DesktopBackend;
  port: number;
}

/**
 * A backend address, or null when it is not one the app could open.
 *
 * http is allowed as well as https: a self-hosted deployment on a home network
 * or behind a reverse proxy on the same machine is a normal thing to point the
 * app at, and refusing it would only push people to a tunnel.
 */
const normalizeBackendUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

/**
 * Whether the app could open this address.
 *
 * The check a saved setting is put through, exported so a dialog can refuse an
 * address before it is ever written down.
 */
export const isValidBackendUrl = (value: unknown): boolean =>
  normalizeBackendUrl(value) !== null;

/**
 * Falls back to the local gateway: an address the app cannot open is worse
 * than one it never asked for, and a broken setting must not leave the app
 * with nowhere to go.
 */
export const normalizeDesktopBackend = (value: unknown): DesktopBackend => {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { mode?: unknown; url?: unknown })
      : null;
  // The mode is read rather than inferred from the address, so a stale or
  // half-written setting cannot quietly switch the app to a backend the user
  // did not ask for.
  const url =
    record?.mode === 'remote' ? normalizeBackendUrl(record.url) : null;

  return url ? { mode: 'remote', url } : { mode: 'local' };
};

/**
 * The one desktop setting the console can change.
 *
 * It lives in a file inside `userData` rather than in the storage database
 * because the value is needed before storage exists: the main process has to
 * know which port to start the gateway on, and the database is inside that
 * gateway.
 */
export const defaultDesktopSettings = (): DesktopSettings => ({
  backend: { mode: 'local' },
  port: DEFAULT_GATEWAY_PORT,
});

export const desktopSettingsPath = (userDataDir: string): string =>
  path.join(userDataDir, DESKTOP_SETTINGS_FILENAME);

export const isDesktopMode = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[DESKTOP_MODE_ENV]?.trim() === '1';

export const readDesktopSettings = (userDataDir: string): DesktopSettings => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(desktopSettingsPath(userDataDir), 'utf8'),
    ) as { backend?: unknown; port?: unknown };

    return {
      backend: normalizeDesktopBackend(parsed?.backend),
      port: normalizePort(parsed?.port),
    };
  } catch {
    // A missing file is the normal case — the setting has never been changed —
    // and a damaged one is not worth failing a launch over.
    return defaultDesktopSettings();
  }
};

export const writeDesktopSettings = (
  userDataDir: string,
  settings: DesktopSettings,
): DesktopSettings => {
  const next: DesktopSettings = {
    backend: normalizeDesktopBackend(settings.backend),
    port: normalizePort(settings.port),
  };

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    desktopSettingsPath(userDataDir),
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );

  return next;
};

/**
 * The port the app should try first.
 *
 * A saved setting outranks `CODEBUDDY_DESKTOP_PORT`: the saved value is the one
 * the console shows, so an environment variable the user cannot see would
 * otherwise silently override whatever they typed. The variable still works as
 * the starting point for an install that has never saved one.
 */
export const resolveDesktopPreferredPort = (
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const stored = readDesktopSettings(userDataDir);
  const saved = fs.existsSync(desktopSettingsPath(userDataDir));

  return saved ? stored.port : resolvePreferredPort(env, stored.port);
};

/**
 * Whether the port was asked for by name, rather than left to the app.
 *
 * A named port is a promise to whatever points at it — a firewall rule, a
 * client config, a bookmark — so the app has to take that one or say it cannot,
 * instead of quietly starting on the next number up. An install that has never
 * saved one has promised nothing: it still walks upwards, which is what keeps it
 * usable next to a Docker deployment already serving 8001.
 *
 * The environment variable counts even when it asks for the default: it was
 * typed by someone who meant that number. So does any saved setting, the
 * default included: both ways to save a port now go through a field the user is
 * shown — the window that asks, or the port row in the console's settings — so
 * the number on disk is one they were asked about and answered.
 */
export const isPinnedPort = (
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const named = env.CODEBUDDY_DESKTOP_PORT?.trim();

  if (named && normalizePort(named, 0)) {
    return true;
  }

  return fs.existsSync(desktopSettingsPath(userDataDir));
};
