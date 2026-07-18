import {
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
  updateAdminSessionUsagePreferences,
} from '@/lib/server/admin/session';
import { getUsageAnalytics, type UsageRange } from '@/lib/server/domain/usage';
import { getJsonBody } from '@/lib/server/shared/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const getUsageResponse = async (request: Request): Promise<Response> => {
  const preferences = (await getAdminSessionSummary(request)).usagePreferences;

  return Response.json(
    await getUsageAnalytics({
      accessKey: preferences?.accessKey ?? [],
      credential: preferences?.credential ?? [],
      range: preferences?.range ?? '24h',
    }),
  );
};

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  return getUsageResponse(request);
};

export const PATCH = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const preferences = await updateAdminSessionUsagePreferences(
    request,
    await getJsonBody<{
      accessKey?: unknown;
      autoRefreshSeconds?: unknown;
      credential?: unknown;
      range?: UsageRange;
    }>(request),
  );

  if (!preferences) {
    return Response.json(
      { error: 'An authenticated admin session is required' },
      { status: 401 },
    );
  }

  return Response.json(
    await getUsageAnalytics({
      accessKey: preferences.accessKey,
      credential: preferences.credential,
      range: preferences.range,
    }),
  );
};
