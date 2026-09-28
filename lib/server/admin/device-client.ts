/**
 * The words the desktop app and a deployment say to each other.
 *
 * They live apart from the grant store because both sides need them and neither
 * can afford the other's dependencies: the store reads the database, and the
 * Electron main process reads nothing at all.
 */

/** The client that exists: the desktop app, which has no secret to keep. */
export const DEVICE_CLIENT_ID = 'codebuddy2api-desktop';

/** The grant type a device code is exchanged under. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Where the user approves, relative to whatever address the deployment has. */
export const DEVICE_VERIFICATION_PATH = '/device';
