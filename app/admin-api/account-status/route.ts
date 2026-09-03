import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  checkinAccounts,
  checkinAccount,
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';
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
  const body = await getJsonBody<{ action?: unknown; filename?: unknown }>(
    request,
  );
  const filename =
    typeof body.filename === 'string' ? body.filename.trim() : '';
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
