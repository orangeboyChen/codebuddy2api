import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  checkinAccounts,
  checkinAccount,
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';
import { updateAutoCheckinSettings } from '@/lib/server/domain/auto-checkin';
import { isValidAutoCheckinTime } from '@/lib/server/domain/auto-checkin-settings';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);
  if (authError) return authError;
  const credentials = await getAccountStatusCredentials();
  return Response.json({ credentials, statuses: await getAccountStatus() });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);
  if (authError) return authError;
  const body = await getJsonBody<{
    action?: unknown;
    enabled?: unknown;
    filename?: unknown;
    time?: unknown;
  }>(request);
  const filename =
    typeof body.filename === 'string' ? body.filename.trim() : '';

  if (body.action === 'auto-checkin') {
    if (!filename) {
      return Response.json(
        { error: 'filename is required to update auto check-in' },
        { status: 400 },
      );
    }

    if (body.time !== undefined && !isValidAutoCheckinTime(body.time)) {
      return Response.json(
        { error: 'Invalid auto check-in time, expected HH:MM' },
        { status: 400 },
      );
    }

    try {
      const autoCheckin = await updateAutoCheckinSettings(filename, {
        enabled: body.enabled,
        time: body.time,
      });

      return Response.json({ autoCheckin, filename });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to update auto check-in';

      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (body.action === 'checkin') {
    if (filename) {
      return Response.json({ status: await checkinAccount(filename) });
    }
    return Response.json({ statuses: await checkinAccounts() });
  }
  return Response.json({
    statuses: await getAccountStatus(filename ? [filename] : undefined),
  });
};
