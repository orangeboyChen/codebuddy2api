import { selectCredential } from '@/lib/server/credentials';
import { createErrorResponse, getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{ index?: unknown }>(request);

  if (typeof body.index !== 'number' || !Number.isInteger(body.index)) {
    return createErrorResponse(400, 'index must be an integer');
  }

  return Response.json(selectCredential(body.index));
};
