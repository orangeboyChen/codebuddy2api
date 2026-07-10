import type { NextRequest } from 'next/server';

import { getAdminAuthErrorResponse } from '@/lib/server/auth';
import { deleteCredentialByIndex } from '@/lib/server/credentials';
import { createErrorResponse, getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getAdminAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{ index?: unknown }>(request);

  if (typeof body.index !== 'number' || !Number.isInteger(body.index)) {
    return createErrorResponse(400, 'index must be an integer');
  }

  return Response.json(deleteCredentialByIndex(body.index));
};
