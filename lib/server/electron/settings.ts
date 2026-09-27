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

export interface DesktopSettings {
  port: number;
}

/**
 * The one desktop setting the console can change.
 *
 * It lives in a file inside `userData` rather than in the storage database
 * because the value is needed before storage exists: the main process has to
 * know which port to start the gateway on, and the database is inside that
 * gateway.
 */
export const defaultDesktopSettings = (): DesktopSettings => ({
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
    ) as { port?: unknown };

    return { port: normalizePort(parsed?.port) };
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
