import {
  clearDebugLogs,
  getDebugSettings,
  listDebugLogs,
  updateDebugSettings,
} from '@/lib/server/debug';
import { getJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (): Promise<Response> => {
  const settings = getDebugSettings();

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    items: listDebugLogs(),
    maxEntries: settings.maxEntries,
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    autoRefreshSeconds?: number;
    enabled?: boolean;
    maxEntries?: number;
  }>(request);
  const settings = updateDebugSettings({
    autoRefreshSeconds: body.autoRefreshSeconds,
    enabled: body.enabled,
    maxEntries: body.maxEntries,
  });

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    items: listDebugLogs(),
    maxEntries: settings.maxEntries,
    message: 'Debug 设置已保存。',
  });
};

export const DELETE = async (): Promise<Response> => {
  clearDebugLogs();

  return Response.json({
    autoRefreshSeconds: getDebugSettings().autoRefreshSeconds,
    enabled: getDebugSettings().enabled,
    items: [],
    maxEntries: getDebugSettings().maxEntries,
    message: 'Debug 记录已清空。',
  });
};
