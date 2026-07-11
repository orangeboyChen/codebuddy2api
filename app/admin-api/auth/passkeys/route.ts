import {
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
  listAdminPasskeys,
} from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({
    passkeys: await listAdminPasskeys(),
    session: await getAdminSessionSummary(request),
  });
};
