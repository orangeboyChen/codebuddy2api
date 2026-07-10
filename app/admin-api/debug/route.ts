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
    enabled: settings.enabled,
    items: listDebugLogs(),
    maxEntries: settings.maxEntries,
  });
};

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    enabled?: boolean;
    maxEntries?: number;
  }>(request);
  const settings = updateDebugSettings({
    enabled: body.enabled,
    maxEntries: body.maxEntries,
  });

  return Response.json({
    enabled: settings.enabled,
    items: listDebugLogs(),
    maxEntries: settings.maxEntries,
    message: 'Debug 设置已保存。',
  });
};

export const DELETE = async (): Promise<Response> => {
  clearDebugLogs();

  return Response.json({
    enabled: getDebugSettings().enabled,
    items: [],
    maxEntries: getDebugSettings().maxEntries,
    message: 'Debug 记录已清空。',
  });
};
