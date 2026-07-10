import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/debug';
import { proxyChatCompletions } from '@/lib/server/codebuddy';
import { getJsonBody } from '@/lib/server/http';

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
        route: '/v1/chat/completions',
      })
    : undefined;
  const authError = getClientAuthErrorResponse(request);

  if (authError) {
    finalizeDebugTrace(debugTrace, authError);
    return authError;
  }

  const response = await proxyChatCompletions(
    request,
    body,
    undefined,
    debugTrace,
  );
  finalizeDebugTrace(debugTrace, response);
  return response;
};
