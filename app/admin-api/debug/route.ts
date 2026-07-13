import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  clearDebugLogs,
  getDebugSettings,
  listDebugLogs,
  updateDebugSettings,
} from '@/lib/server/domain/debug';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const settings = await getDebugSettings();

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    items: await listDebugLogs(),
    maxEntries: settings.maxEntries,
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const body = await getJsonBody<{
    autoRefreshSeconds?: number;
    enabled?: boolean;
    maxEntries?: number;
  }>(request);
  const settings = await updateDebugSettings({
    autoRefreshSeconds: body.autoRefreshSeconds,
    enabled: body.enabled,
    maxEntries: body.maxEntries,
  });

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    items: await listDebugLogs(),
    maxEntries: settings.maxEntries,
  });
};

export const DELETE = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  await clearDebugLogs();
  const settings = await getDebugSettings();

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    items: [],
    maxEntries: settings.maxEntries,
  });
};
