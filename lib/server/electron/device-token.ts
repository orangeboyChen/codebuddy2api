/**
 * The token a deployment handed this app, kept on disk.
 *
 * It is the desktop half of the device authorization grant: the user approved
 * this app on the deployment's own page, in a browser, and what came back is a
 * token this app sends with everything it forwards there. It is a credential, so
 * it is kept apart from the settings — a file of its own, readable by nobody but
 * the user this app runs as.
 *
 * It is also kept *for* an address: a token is a promise that deployment made to
 * this app, and carrying it to another one would be presenting someone else's
 * introduction.
 */

import fs from 'node:fs';
import path from 'node:path';

/** How the token reaches the gateway, which is the half that forwards it. */
export const DESKTOP_DEVICE_TOKEN_ENV = 'CODEBUDDY_DESKTOP_DEVICE_TOKEN';

export const DESKTOP_DEVICE_TOKEN_FILENAME = 'desktop-device-token.json';

interface StoredDeviceToken {
  token: string;
  url: string;
}

/**
 * The token this gateway sends to the deployment with everything it forwards.
 *
 * Null when there is none, which is every install but a desktop one pointed at a
 * deployment the user approved this app on.
 */
export const deviceToken = (
  env: Record<string, string | undefined> = process.env,
): string | null => {
  const token = env[DESKTOP_DEVICE_TOKEN_ENV]?.trim();

  return token ? token : null;
};

/** Addresses compared as they are written, so a trailing slash is one address. */
const sameDeployment = (a: string, b: string): boolean =>
  a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

export const desktopDeviceTokenPath = (userDataDir: string): string =>
  path.join(userDataDir, DESKTOP_DEVICE_TOKEN_FILENAME);

/**
 * The token saved for this deployment, which is no token at all for another.
 */
export const readDeviceToken = (
  userDataDir: string,
  url: string,
): string | null => {
  try {
    const stored = JSON.parse(
      fs.readFileSync(desktopDeviceTokenPath(userDataDir), 'utf8'),
    ) as StoredDeviceToken;

    if (
      typeof stored?.token !== 'string' ||
      !stored.token.trim() ||
      typeof stored?.url !== 'string' ||
      !sameDeployment(stored.url, url)
    ) {
      return null;
    }

    return stored.token.trim();
  } catch {
    // No file is the normal case — nothing has been approved yet — and a
    // damaged one is not worth failing a launch over.
    return null;
  }
};

export const writeDeviceToken = (
  userDataDir: string,
  { token, url }: { token: string; url: string },
): void => {
  const next: StoredDeviceToken = { token: token.trim(), url: url.trim() };

  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    desktopDeviceTokenPath(userDataDir),
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );
};

/**
 * Forgetting the token: what signing out here is.
 *
 * The file is what this app has; the deployment is asked to forget its side too,
 * which is the caller's business — a token nobody holds should not still work.
 */
export const forgetDeviceToken = (userDataDir: string): void => {
  try {
    fs.rmSync(desktopDeviceTokenPath(userDataDir), { force: true });
  } catch {
    // Nothing to forget, or a directory it cannot be removed from: either way
    // the app keeps no token in memory after this.
  }
};
