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
  const debugId = new URL(request.url).searchParams.get('id');
  const logs = await listDebugLogs();

  if (debugId) {
    const item = logs.find((log) => log.id === debugId);
    return Response.json({ item: item ?? null }, { status: item ? 200 : 404 });
  }

  return Response.json({
    autoRefreshSeconds: settings.autoRefreshSeconds,
    enabled: settings.enabled,
    // Payload bodies are loaded on demand through ?id= to keep list refreshes fast.
    items: logs.map((log) => ({
      credentialFilename: log.credentialFilename,
      createdAt: log.createdAt,
      elapsedMs: log.elapsedMs,
      error: log.error,
      id: log.id,
      model: log.model,
      requestKey: log.requestKey,
      route: log.route,
      usage: log.usage,
      transformedResponse: log.transformedResponse
        ? { status: log.transformedResponse.status }
        : null,
      upstreamRequest: log.upstreamRequest
        ? { method: log.upstreamRequest.method, url: log.upstreamRequest.url }
        : null,
      upstreamResponse: log.upstreamResponse
        ? { status: log.upstreamResponse.status }
        : null,
    })),
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
