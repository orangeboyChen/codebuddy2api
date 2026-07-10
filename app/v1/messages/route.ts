import type { NextRequest } from 'next/server';

import { getAnthropicAuthErrorResponse } from '@/lib/server/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/debug';
import { handleMessagesRequest } from '@/lib/server/anthropic';
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
        route: '/v1/messages',
      })
    : undefined;
  const authError = getAnthropicAuthErrorResponse(request);

  if (authError) {
    finalizeDebugTrace(debugTrace, authError);
    return authError;
  }

  const response = await handleMessagesRequest(request, body, debugTrace);
  finalizeDebugTrace(debugTrace, response);
  return response;
};
