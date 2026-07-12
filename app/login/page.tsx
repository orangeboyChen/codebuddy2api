import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import LoginClient from '@/features/admin/login-client';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import { getMessages } from '@/lib/i18n/messages';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

const LoginPage = async () => {
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
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/login`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  const session = await getAdminSessionSummary(request);
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
      initialSession={session}
      initialTheme={parseThemeMode(cookieStore.get(themeCookieName)?.value)}
      locale={locale}
      localePreference={localePreference}
      systemLocaleLabel={messages.Admin.languageSystem}
      themeLabels={{
        dark: messages.Admin.themeDark,
        light: messages.Admin.themeLight,
        system: messages.Admin.themeSystem,
      }}
      translations={messages.Admin.loginPage}
    />
  );
};

export default LoginPage;
