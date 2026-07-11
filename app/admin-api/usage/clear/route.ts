import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { clearUsageHistory } from '@/lib/server/domain/usage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  await clearUsageHistory();

  return Response.json({
    success: true,
  });
};
