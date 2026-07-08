import type { NextRequest } from 'next/server';

import { getAuthErrorResponse } from '@/lib/server/auth';
import { deleteCredentialByIndex } from '@/lib/server/credentials';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{ index?: number }>(request);
  return Response.json(deleteCredentialByIndex(Number(body.index)));
};
