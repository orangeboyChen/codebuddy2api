import { resolveRequestOrigin } from '@/lib/server/shared/http';
import { hasAdminAccountAsync } from '@/lib/server/admin/session';
import {
  isLoopbackRedirectUri,
  requestDeviceAuthorization,
} from '@/lib/server/admin/device';

/**
 * Where a device begins: it asks for a code, and gets nothing but codes back.
 *
 * Deliberately not behind the session: a device has no cookie to bring, and the
 * sign-in is what this endpoint is the start of. What it answers with is not a
 * credential either — a `device_code` only lets a client ask whether the user
 * approved, and a `user_code` is what a person types on a screen in front of
 * them.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const { host, protocol } = await resolveRequestOrigin(request.headers, {
    host: new URL(request.url).host,
    protocol: new URL(request.url).protocol.replace(/:$/, ''),
  });

  let configured = false;

  try {
    configured = await hasAdminAccountAsync();
  } catch {
    return Response.json(
      {
        error: {
          code: 'admin_auth_storage_unavailable',
          message: 'Admin authentication storage is unreadable',
        },
      },
      { status: 503 },
    );
  }

  // A console nobody signs in to has nothing to approve a device into: signing
  // one in would only give it a token for a door that is already open.
  if (!configured) {
    return Response.json(
      {
        error: {
          code: 'admin_auth_not_configured',
          message: 'This console has no administrator account to sign in to',
        },
      },
      { status: 409 },
    );
  }

  // Where the browser is sent back to once the user has approved, when the
  // device named one. Read off the request rather than assumed: a device on
  // someone's machine is the only thing that knows which address it listens on.
  const body = (await request.json().catch(() => null)) as {
    redirect_uri?: unknown;
  } | null;
  const redirectUri =
    typeof body?.redirect_uri === 'string' ? body.redirect_uri : '';

  if (redirectUri && !isLoopbackRedirectUri(redirectUri)) {
    return Response.json(
      {
        error: {
          code: 'admin_device_redirect_not_loopback',
          message: 'The redirect address has to be a loopback one',
        },
      },
      { status: 400 },
    );
  }

  try {
    return Response.json(
      await requestDeviceAuthorization({
        origin: `${protocol}://${host}`,
        redirectUri,
      }),
    );
  } catch {
    return Response.json(
      {
        error: {
          code: 'admin_device_storage_unavailable',
          message: 'Admin device storage is unwritable',
        },
      },
      { status: 503 },
    );
  }
};
