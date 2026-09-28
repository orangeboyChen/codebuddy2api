import { readJsonBodyOrFailure } from '@/lib/server/shared/http';
import {
  exchangeDeviceGrant,
  isDeviceGrantType,
  revokeDeviceToken,
} from '@/lib/server/admin/device';
import { DEVICE_CLIENT_ID } from '@/lib/server/admin/device-client';

/**
 * The end of a device's sign-in: it asks for its token, and the user's approval
 * in a browser is what answers.
 *
 * The waiting is the point. A device is told to come back rather than handed
 * nothing, because the thing it is waiting for happens on another screen — and a
 * client that cannot be told "not yet" has to be given a token the moment it
 * asks, which is a token anyone who asked would get.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const errorResponse = (error: string, status = 400): Response =>
  Response.json({ error }, { status });

export const POST = async (request: Request): Promise<Response> => {
  const parsed = await readJsonBodyOrFailure<{
    client_id?: unknown;
    device_code?: unknown;
    grant_type?: unknown;
  }>(request);

  if ('failure' in parsed) {
    const { message, status } = parsed.failure;

    return Response.json({ error: { message } }, { status });
  }

  const { body } = parsed;

  if (!isDeviceGrantType(body.grant_type)) {
    return errorResponse('unsupported_grant_type');
  }

  // Named for the record and for what the page says was approved; it is not a
  // secret, so it is not a credential, and a client that names another one is
  // simply not a client this console has.
  if (
    typeof body.client_id === 'string' &&
    body.client_id.trim() &&
    body.client_id.trim() !== DEVICE_CLIENT_ID
  ) {
    return errorResponse('invalid_client');
  }

  const deviceCode =
    typeof body.device_code === 'string' ? body.device_code : '';

  try {
    const exchanged = await exchangeDeviceGrant({ deviceCode });

    return 'error' in exchanged
      ? errorResponse(exchanged.error)
      : Response.json(exchanged);
  } catch {
    return errorResponse('temporarily_unavailable', 503);
  }
};

/**
 * Forgetting the token a device was given: the app asks for it when the user
 * signs out there. A token nobody holds any more should not still open a door.
 */
export const DELETE = async (request: Request): Promise<Response> => {
  try {
    await revokeDeviceToken(request);
  } catch {
    return errorResponse('temporarily_unavailable', 503);
  }

  return Response.json({ success: true });
};
