import type { NextRequest } from 'next/server';

import { getAdminAuthErrorResponse } from '@/lib/server/auth';
import {
  getActiveConfig,
  SETTING_LABELS,
  updateSettings,
} from '@/lib/server/config';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: NextRequest): Promise<Response> => {
  const authError = getAdminAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({
    settings: getActiveConfig(),
    labels: SETTING_LABELS,
  });
};

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = getAdminAuthErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{
    settings?: Record<string, unknown>;
  }>(request);

  return Response.json({
    message: '设置已保存并成功热加载！',
    settings: updateSettings(body.settings ?? {}),
  });
};
