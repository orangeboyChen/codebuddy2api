import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import AdminPageLayout from '@/app/page-shell';
import type { TabKey } from '@/app/page-data';
import { getInitialData } from '@/app/page-loader';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import {
  fetchUpstreamSessionSummary,
  resolveAdminUpstream,
} from '@/lib/server/admin/upstream';
import { isDesktopMode } from '@/lib/server/electron/settings';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { resolveRequestOrigin } from '@/lib/server/shared/http';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export const AdminPage = async ({
  children,
  initialTab,
}: {
  children: ReactNode;
  initialTab: TabKey;
}) => {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const { protocol, host } = await resolveRequestOrigin(headerStore, {
    host: 'localhost',
    protocol: 'http',
  });
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  // Whose password applies: a desktop install serving its own data has none,
  // but one showing a deployment's data is that deployment's console, and the
  // deployment is reachable from a network.
  const upstream = resolveAdminUpstream();
  const session = upstream
    ? await fetchUpstreamSessionSummary({ cookie: cookieHeader, upstream })
    : await getAdminSessionSummary(request);
  const desktop = isDesktopMode() && !upstream;
  const sessionAuthenticated = session?.authenticated ?? false;

  if (!desktop && session?.accountConfigured && !sessionAuthenticated) {
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
      // Nothing to load here for a deployment's data: the pages are this
      // build's, and the numbers are the deployment's, fetched by the console
      // itself through `/admin-api`, which is forwarded.
      initialData={
        upstream
          ? undefined
          : await getInitialData({
              locale,
              tab: initialTab,
              usagePreferences: session?.usagePreferences,
            })
      }
      initialLocalePreference={localePreference}
      showLogout={!desktop && sessionAuthenticated}
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
