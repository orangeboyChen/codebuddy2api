import { getAccessKeySecret } from '@/lib/server/domain/access-keys';
import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const { id } = await context.params;
  const secret = await getAccessKeySecret(id);

  if (!secret) {
    return Response.json({ error: 'Access key not found' }, { status: 404 });
  }

  return Response.json(secret);
};
