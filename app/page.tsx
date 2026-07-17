import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import AdminPageLayout from '@/app/page-shell';
import type { AdminConsoleInitialData } from '@/app/page-data';
import type {
  AccessKeySummary,
  CredentialSummary,
} from '@/app/credentials/credentials';
import type { TabKey } from '@/app/page-data';
import { listAccessKeys } from '@/lib/server/domain/access-keys';
import {
  getAdminSessionSummary,
  isAdminSessionAuthenticated,
} from '@/lib/server/admin/session';
import { getActiveConfig, getSettingLabels } from '@/lib/server/domain/config';
import {
  getCurrentCredentialInfo,
  listCredentials,
} from '@/lib/server/domain/credentials';
import { getUsageStats } from '@/lib/server/domain/stats';
import { getUsageAnalytics } from '@/lib/server/domain/usage';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
  type AppLocale,
} from '@/lib/i18n/routing';
import { getMessages } from '@/lib/i18n/messages';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

const buildApiEndpoint = async () => {
  const headerStore = await headers();
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';

  return `${protocol}://${host}/v1`;
};

const formatInitialHealthLabel = (locale: AppLocale, timestamp: string) => {
  const checkedAt = new Date(timestamp).toLocaleString(locale);
  const { serviceCheckedAt } = getMessages(locale).Admin.console;

  return `${serviceCheckedAt} ${checkedAt}`;
};

const getInitialData = async (
  locale: AppLocale,
): Promise<AdminConsoleInitialData> => {
  const timestamp = new Date().toISOString();
  const [
    accessKeys,
    apiEndpoint,
    credentials,
    currentCredential,
    activeConfig,
    stats,
    usage,
  ] = await Promise.all([
    listAccessKeys(),
    buildApiEndpoint(),
    listCredentials(),
    getCurrentCredentialInfo(),
    getActiveConfig(),
    getUsageStats(),
    getUsageAnalytics({ range: '24h' }),
  ]);

  return {
    accessKeys: accessKeys.access_keys as unknown as AccessKeySummary[],
    apiEndpoint,
    credentials: credentials.credentials as unknown as CredentialSummary[],
    currentCredential:
      currentCredential as unknown as AdminConsoleInitialData['currentCredential'],
    debug: {
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    },
    health: {
      checkedAtLabel: formatInitialHealthLabel(locale, timestamp),
      status: 'healthy',
      timestamp,
      uptimeText: formatInitialHealthLabel(locale, timestamp),
    },
    settings: {
      labels: getSettingLabels(locale),
      values: { ...activeConfig },
    },
    stats,
    usage: {
      ...usage,
      updatedAtLabel: new Date(timestamp).toLocaleTimeString(locale),
    },
  };
};

export const AdminPage = async ({
  children,
  initialTab,
}: {
  children: ReactNode;
  initialTab: TabKey;
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
  const sessionAuthenticated = await isAdminSessionAuthenticated(request);

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
      initialData={await getInitialData(locale)}
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
