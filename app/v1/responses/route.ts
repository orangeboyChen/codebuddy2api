import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/proxy/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import { readJsonBodyOrErrorResponse } from '@/lib/server/shared/http';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = await getClientAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  const parsed =
    await readJsonBodyOrErrorResponse<Record<string, unknown>>(request);

  if ('response' in parsed) {
    return parsed.response;
  }

  const body = parsed.body;
  const debugTrace = (await isDebugEnabled())
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          request.headers.get('x-api-key') ??
          request.headers.get('authorization'),
        route: '/v1/responses',
      })
    : undefined;

  const response = await handleResponsesRequest(request, body, debugTrace);
  return finalizeDebugTrace(debugTrace, response);
};
