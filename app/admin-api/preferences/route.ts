import { NextResponse } from 'next/server';

import {
  localeCookieName,
  localePreferenceCookieName,
  locales,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { resolvedThemeCookieName, themeCookieName } from '@/lib/theme';
import { getForwardedHeaderValue, getJsonBody } from '@/lib/server/shared/http';
import { getActiveConfig } from '@/lib/server/domain/config';

const maxAge = 60 * 60 * 24 * 365;

const getCookieOptions = async (request: Request) => {
  // Same rule as the admin session cookie: trust the forwarded header only when
  // this deployment says a proxy is allowed to set it, and take the first entry
  // of a comma-separated list rather than the whole header.
  const config = await getActiveConfig();
  const forwarded =
    config.CODEBUDDY_ADMIN_TRUST_PROXY &&
    getForwardedHeaderValue(request.headers, 'x-forwarded-proto');
  const protocol = forwarded || new URL(request.url).protocol.replace(':', '');

  return {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'lax' as const,
    secure: protocol === 'https',
  };
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    localePreference?: unknown;
    resolvedTheme?: unknown;
    theme?: unknown;
  }>(request);
  const response = NextResponse.json({ success: true });
  const cookieOptions = await getCookieOptions(request);

  if (typeof body.localePreference === 'string') {
    const localePreference = body.localePreference;

    if (
      localePreference !== systemLocalePreference &&
      !locales.includes(localePreference as (typeof locales)[number])
    ) {
      return Response.json(
        { error: { message: 'Invalid locale preference' } },
        { status: 400 },
      );
    }

    response.cookies.set(
      localePreferenceCookieName,
      localePreference,
      cookieOptions,
    );

    if (localePreference === systemLocalePreference) {
      response.cookies.set(localeCookieName, '', {
        ...cookieOptions,
        maxAge: 0,
      });
    } else {
      response.cookies.set(localeCookieName, localePreference, cookieOptions);
    }
  }

  if (typeof body.theme === 'string') {
    if (!['dark', 'light', 'system'].includes(body.theme)) {
      return Response.json(
        { error: { message: 'Invalid theme' } },
        { status: 400 },
      );
    }

    response.cookies.set(themeCookieName, body.theme, cookieOptions);

    if (body.resolvedTheme === 'dark' || body.resolvedTheme === 'light') {
      response.cookies.set(
        resolvedThemeCookieName,
        body.resolvedTheme,
        cookieOptions,
      );
    }
  }

  return response;
};
