import type { NextRequest } from 'next/server';

import { getAdminAuthErrorResponse } from '@/lib/server/auth';
import { toggleAutoRotation } from '@/lib/server/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getAdminAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json(toggleAutoRotation());
};
