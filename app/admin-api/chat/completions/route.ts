import type { NextRequest } from 'next/server';

import {
  createDebugTrace,
  finalizeDebugTrace,
  isDebugEnabled,
} from '@/lib/server/debug';
import {
  proxyChatCompletions,
  resolveProxyContextByCredentialFilename,
} from '@/lib/server/codebuddy';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const body = await getJsonBody<Record<string, unknown>>(request);
  const debugTrace = isDebugEnabled()
    ? createDebugTrace({
        requestBody: body,
        requestKey:
          typeof body.credential_filename === 'string' &&
          body.credential_filename.trim()
            ? body.credential_filename.trim()
            : 'admin-api-test',
        route: '/admin-api/chat/completions',
      })
    : undefined;
  const credentialFilename =
    typeof body.credential_filename === 'string'
      ? body.credential_filename.trim()
      : '';

  try {
    const context = credentialFilename
      ? resolveProxyContextByCredentialFilename(credentialFilename)
      : undefined;
    const response = await proxyChatCompletions(
      request,
      body,
      context,
      debugTrace,
    );
    finalizeDebugTrace(debugTrace, response);
    return response;
  } catch (error) {
    const response = Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'API 测试失败',
        },
      },
      { status: 400 },
    );
    finalizeDebugTrace(debugTrace, response);
    return response;
  }
};
