import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/auth';
import { getModelsResponse } from '@/lib/server/codebuddy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const authError = getClientAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return getModelsResponse();
};
