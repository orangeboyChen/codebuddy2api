import { readJsonBodyOrFailure } from '@/lib/server/shared/http';
import { approveDeviceGrant } from '@/lib/server/admin/device';
import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';

/**
 * The approval itself, which is the one part of this that needs a sign-in: the
 * user is saying "yes, this device is mine", so it is asked of someone this
 * console already knows is the admin.
 *
 * That is also why the desktop app sends people here rather than asking for
 * their password: a passkey works on this address, in a browser, and would not
 * work in the app's window at `127.0.0.1` however the password were asked for.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const parsed = await readJsonBodyOrFailure<{ user_code?: unknown }>(request);

  if ('failure' in parsed) {
    const { message, status } = parsed.failure;

    return Response.json({ error: { message } }, { status });
  }

  try {
    const outcome = await approveDeviceGrant({
      userCode:
        typeof parsed.body.user_code === 'string' ? parsed.body.user_code : '',
    });

    if (outcome.status === 'missing') {
      return Response.json(
        {
          error: {
            message: 'That code is not one this console is waiting for',
          },
        },
        { status: 404 },
      );
    }

    return Response.json({ clientId: outcome.clientId, success: true });
  } catch {
    return Response.json(
      { error: { message: 'Admin device storage is unwritable' } },
      { status: 503 },
    );
  }
};
