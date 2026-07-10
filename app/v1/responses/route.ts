import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/debug';
import { getJsonBody } from '@/lib/server/http';
import { handleResponsesRequest } from '@/lib/server/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const body = await getJsonBody<Record<string, unknown>>(request);
  const debugTrace = isDebugEnabled()
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          request.headers.get('x-api-key') ??
          request.headers.get('authorization'),
        route: '/v1/responses',
      })
    : undefined;
  const authError = getClientAuthErrorResponse(request);

  if (authError) {
    finalizeDebugTrace(debugTrace, authError);
    return authError;
  }

  const response = await handleResponsesRequest(request, body, debugTrace);
  finalizeDebugTrace(debugTrace, response);
  return response;
};
