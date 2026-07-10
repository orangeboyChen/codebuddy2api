import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/auth';
import { getJsonBody } from '@/lib/server/http';
import { handleResponsesRequest } from '@/lib/server/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getClientAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return handleResponsesRequest(request, await getJsonBody(request));
};
