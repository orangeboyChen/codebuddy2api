import type { NextRequest } from 'next/server';

import { getAuthCallbackResponse } from '@/lib/server/codebuddy-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  return getAuthCallbackResponse(request.nextUrl.searchParams);
};
