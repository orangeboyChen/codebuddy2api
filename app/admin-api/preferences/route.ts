import { NextResponse } from 'next/server';

import {
  localeCookieName,
  localePreferenceCookieName,
  locales,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { resolvedThemeCookieName, themeCookieName } from '@/lib/theme';
import { getJsonBody } from '@/lib/server/shared/http';

const maxAge = 60 * 60 * 24 * 365;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = async (request: Request): Promise<Response> => {
  const body = await getJsonBody<{
    localePreference?: unknown;
    resolvedTheme?: unknown;
    theme?: unknown;
  }>(request);
  const response = NextResponse.json({ success: true });

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

    response.cookies.set(localePreferenceCookieName, localePreference, {
      maxAge,
      path: '/',
      sameSite: 'lax',
    });

    if (localePreference === systemLocalePreference) {
      response.cookies.delete(localeCookieName);
    } else {
      response.cookies.set(localeCookieName, localePreference, {
        maxAge,
        path: '/',
        sameSite: 'lax',
      });
    }
  }

  if (typeof body.theme === 'string') {
    if (!['dark', 'light', 'system'].includes(body.theme)) {
      return Response.json(
        { error: { message: 'Invalid theme' } },
        { status: 400 },
      );
    }

    response.cookies.set(themeCookieName, body.theme, {
      maxAge,
      path: '/',
      sameSite: 'lax',
    });

    if (body.resolvedTheme === 'dark' || body.resolvedTheme === 'light') {
      response.cookies.set(resolvedThemeCookieName, body.resolvedTheme, {
        maxAge,
        path: '/',
        sameSite: 'lax',
      });
    }
  }

  return response;
};
