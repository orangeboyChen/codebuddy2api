import type { NextRequest } from 'next/server';

import { getAnthropicAuthErrorResponse } from '@/lib/server/proxy/auth';
import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/domain/debug';
import {
  createAnthropicError,
  handleMessagesRequest,
} from '@/lib/server/proxy/anthropic';
import { readJsonBodyOrFailure } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = await getAnthropicAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  // Body errors go through createAnthropicError so this route keeps returning
  // `type: "error"` with an Anthropic error type, matching every other failure
  // on the route. A 413 maps to request_too_large and a 400 to
  // invalid_request_error.
  const parsed = await readJsonBodyOrFailure<Record<string, unknown>>(request);

  if ('failure' in parsed) {
    return createAnthropicError(parsed.failure.status, parsed.failure.message);
  }

  const body = parsed.body;
  const debugTrace = (await isDebugEnabled())
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          request.headers.get('x-api-key') ??
          request.headers.get('authorization'),
        route: '/v1/messages',
      })
    : undefined;

  const response = await handleMessagesRequest(request, body, debugTrace);
  return finalizeDebugTrace(debugTrace, response);
};
