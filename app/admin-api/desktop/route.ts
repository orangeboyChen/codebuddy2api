import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  DESKTOP_USER_DATA_ENV,
  isDesktopMode,
  normalizeDesktopPort,
  readDesktopSettings,
  writeDesktopSettings,
} from '@/lib/server/electron/settings';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface DesktopSettingsPayload {
  desktop: boolean;
  /** The port the gateway is listening on right now. */
  port: number;
  /** The port saved for the next start — the value the console edits. */
  preferredPort: number;
  /** True right after a save: the app is restarting the gateway. */
  restarting?: boolean;
  /**
   * Fixed. A desktop install owns its own database inside `userData`, so there
   * is no other backend to offer.
   */
  storageBackend: 'sqlite';
}

const desktopUserDataDir = (): string =>
  process.env[DESKTOP_USER_DATA_ENV]?.trim() ?? '';

const readState = (): DesktopSettingsPayload => {
  const desktop = isDesktopMode();
  const userDataDir = desktopUserDataDir();
  // The main process starts the gateway with `PORT` set, so this is the port it
  // actually ended up on — which is not always the requested one.
  const declared = Number.parseInt(process.env.PORT ?? '', 10);
  const port = Number.isInteger(declared) ? declared : 0;
  const preferredPort =
    desktop && userDataDir ? readDesktopSettings(userDataDir).port : port;

  return { desktop, port, preferredPort, storageBackend: 'sqlite' };
};

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json(readState());
};

/**
 * Saves the port the desktop app should use. The gateway cannot rebind itself,
 * so the Electron main process watches the settings file and restarts it —
 * `restarting` tells the console to expect its own page to go away.
 */
export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const state = readState();

  if (!state.desktop || !desktopUserDataDir()) {
    return Response.json(
      {
        error: {
          message: 'Desktop settings are only available in the desktop app',
        },
      },
      { status: 404 },
    );
  }

  const body = await getJsonBody<{ port?: unknown }>(request);
  const port = normalizeDesktopPort(body.port, 0);

  if (!port) {
    return Response.json(
      { error: { message: 'Port must be a number between 1 and 65535' } },
      { status: 400 },
    );
  }

  writeDesktopSettings(desktopUserDataDir(), { port });

  return Response.json({ ...readState(), restarting: true });
};
