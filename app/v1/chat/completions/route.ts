import type { NextRequest } from 'next/server';

import { getAuthErrorResponse } from '@/lib/server/auth';
import { proxyChatCompletions } from '@/lib/server/codebuddy';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return proxyChatCompletions(request, await getJsonBody(request));
};
