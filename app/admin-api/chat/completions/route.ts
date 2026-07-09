import type { NextRequest } from 'next/server';

import { proxyChatCompletions } from '@/lib/server/codebuddy';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  return proxyChatCompletions(request, await getJsonBody(request));
};
