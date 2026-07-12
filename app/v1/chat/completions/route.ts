import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/proxy/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = await getClientAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<Record<string, unknown>>(request);
  const debugTrace = (await isDebugEnabled())
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          request.headers.get('x-api-key') ??
          request.headers.get('authorization'),
        route: '/v1/chat/completions',
      })
    : undefined;

  const response = await proxyChatCompletions(
    request,
    body,
    undefined,
    debugTrace,
  );
  finalizeDebugTrace(debugTrace, response);
  return response;
};
