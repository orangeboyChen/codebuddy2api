import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import LoginClient from './login-client';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import {
  fetchUpstreamSessionSummary,
  resolveAdminUpstream,
  unreachableSessionSummary,
} from '@/lib/server/admin/upstream';
import { deviceToken } from '@/lib/server/electron/device-token';
import { isDesktopMode } from '@/lib/server/electron/settings';
import { getMessages } from '@/lib/i18n/messages';
import { resolveRequestOrigin } from '@/lib/server/shared/http';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

const LoginPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) => {
  /*
    There is no login page in the desktop app.

    This page belongs to a deployment reached in a browser. The app signs in
    from the window that asks which backend to use, in the browser, on the
    deployment's own page — so a window of the app's that somehow lands here is
    sent back to the console rather than shown a form for a password it cannot
    use.
  */
  if (isDesktopMode()) {
    redirect('/dashboard');
  }

  const { next: nextParam } = await searchParams;
  // Only ever a path on this console: an absolute URL here would be a link
  // someone could hand out that signs a user in and then hands them somewhere
  // else — `//host` included, which a browser reads as a scheme-relative URL,
  // and `\host` too, which it reads as one before it is done with the path.
  const nextPath =
    nextParam && /^\/(?![/\\])/.test(nextParam) ? nextParam : undefined;
  const headerStore = await headers();
  const cookieStore = await cookies();
  const localePreference = parseLocalePreference(
    cookieStore.get(localePreferenceCookieName)?.value ??
      cookieStore.get(localeCookieName)?.value,
  );
  const locale = resolveAppLocale(
    localePreference === systemLocalePreference
      ? (headerStore.get('accept-language') ?? undefined)
      : localePreference,
  );
  const { protocol, host } = await resolveRequestOrigin(headerStore, {
    host: 'localhost',
    protocol: 'http',
  });
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/login`, {
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(headerStore.get('authorization')
        ? { authorization: headerStore.get('authorization') as string }
        : {}),
    },
  });
  // The password belongs to whichever console this is: the deployment's, when
  // this build is only rendering it.
  const upstream = resolveAdminUpstream();
  const summary = upstream
    ? await fetchUpstreamSessionSummary({
        cookie: cookieHeader,
        deviceToken: deviceToken(),
        upstream,
      })
    : await getAdminSessionSummary(request);
  const session = summary ?? unreachableSessionSummary();
  await getTranslations({
    locale,
    namespace: 'Admin.loginPage',
  });
  const messages = getMessages(locale);

  if (session.authenticated) {
    redirect('/');
  }

  return (
    <LoginClient
      // Only set when this build is rendering a deployment: it is the address
      // a passkey saved for the deployment would have to answer to, and the one
      // to open in a browser instead.
      deploymentUrl={upstream ?? undefined}
      initialSession={session}
      initialTheme={parseThemeMode(cookieStore.get(themeCookieName)?.value)}
      locale={locale}
      localePreference={localePreference}
      // Where the sign-in was asked for — a device approval, say — so that
      // signing in does not drop the user back at the dashboard instead.
      nextPath={nextPath}
      translations={messages.Admin.loginPage}
    />
  );
};

export default LoginPage;
