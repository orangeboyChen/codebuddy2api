import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getActiveConfig,
  SETTING_LABELS,
  updateSettings,
} from '@/lib/server/domain/config';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return Response.json({
    settings: await getActiveConfig(),
    labels: SETTING_LABELS,
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{
    settings?: Record<string, unknown>;
  }>(request);

  return Response.json({
    message: '设置已保存并成功热加载！',
    settings: await updateSettings(body.settings ?? {}),
  });
};
