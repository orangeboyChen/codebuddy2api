import { getAdminSessionErrorResponse } from '@/lib/server/admin/session';
import {
  getActiveConfig,
  getSettingLabels,
  updateSettings,
} from '@/lib/server/domain/config';
import { getJsonBody } from '@/lib/server/shared/http';
import { defaultLocale, locales } from '@/lib/i18n/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = async (request: Request): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const localeCookie = request.headers.get('cookie') ?? '';
  const localeMatch = localeCookie.match(
    /(?:^|;\s*)codebuddy2api-locale=([^;]+)/,
  );
  const localeValue = localeMatch?.[1];
  const locale = locales.includes(localeValue as (typeof locales)[number])
    ? (localeValue as (typeof locales)[number])
    : defaultLocale;

  return Response.json({
    settings: await getActiveConfig(),
    labels: getSettingLabels(locale),
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
    settings: await updateSettings(body.settings ?? {}),
  });
};
