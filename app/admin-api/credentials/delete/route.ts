import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import { deleteCredentialByIndex } from '@/lib/server/domain/credentials';
import { createErrorResponse, getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{ index?: unknown }>(request);

  if (typeof body.index !== 'number' || !Number.isInteger(body.index)) {
    return createErrorResponse(400, 'index must be an integer');
  }

  return Response.json(await deleteCredentialByIndex(body.index));
};
