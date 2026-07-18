import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import AdminPageLayout from '@/app/page-shell';
import type { TabKey } from '@/app/page-data';
import { getInitialData } from '@/app/page-loader';
import type { UsageFiltersState } from '@/app/usage/usage';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export const AdminPage = async ({
  children,
  initialTab,
  initialUsageAutoRefreshSeconds,
  initialUsageRequest,
}: {
  children: ReactNode;
  initialTab: TabKey;
  initialUsageAutoRefreshSeconds?: number;
  initialUsageRequest?: UsageFiltersState;
}) => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  const session = await getAdminSessionSummary(request);
  const sessionAuthenticated = session.authenticated;

  if (session.accountConfigured && !sessionAuthenticated) {
    redirect('/login');
  }

  const localePreference = parseLocalePreference(
    cookieStore.get(localePreferenceCookieName)?.value ??
      cookieStore.get(localeCookieName)?.value,
  );
  const locale = resolveAppLocale(
    localePreference === systemLocalePreference
      ? (headerStore.get('accept-language') ?? undefined)
      : localePreference,
  );

  return (
    <AdminPageLayout
      initialData={await getInitialData({
        locale,
        tab: initialTab,
        usageAutoRefreshSeconds: initialUsageAutoRefreshSeconds,
        usageRequest: initialUsageRequest,
      })}
      initialLocalePreference={localePreference}
      showLogout={sessionAuthenticated}
      initialTab={initialTab}
      initialTheme={parseThemeMode(cookieStore.get(themeCookieName)?.value)}
    >
      {children}
    </AdminPageLayout>
  );
};

const RootPage = () => {
  redirect('/dashboard');
};

export default RootPage;
