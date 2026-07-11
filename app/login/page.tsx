import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { defaultLocale, localeCookieName, locales } from '@/lib/i18n/routing';
import { redirect } from 'next/navigation';

import LoginClient from '@/features/admin/login-client';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import { getMessages } from '@/lib/i18n/messages';
import type { AppLocale } from '@/lib/i18n/routing';

export const dynamic = 'force-dynamic';

const resolveLoginLocale = async (): Promise<AppLocale> => {
  const cookieStore = await cookies();
  const locale = cookieStore.get(localeCookieName)?.value;
  const matchedLocale = locales.find((item) => item === locale);

  if (matchedLocale) {
    return matchedLocale;
  }

  return defaultLocale;
};

const LoginPage = async () => {
  const headerStore = await headers();
  const locale = await resolveLoginLocale();
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
    redirect('/admin');
  }

  return (
    <LoginClient
      initialSession={session}
      locale={locale}
      translations={messages.Admin.loginPage}
    />
  );
};

export default LoginPage;
