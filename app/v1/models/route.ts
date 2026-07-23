import type { NextRequest } from 'next/server';

import { getClientAuthErrorResponse } from '@/lib/server/proxy/auth';
import { getModelsResponse } from '@/lib/server/proxy/codebuddy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const authError = await getClientAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return getModelsResponse(request);
};
