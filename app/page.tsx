import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import AdminConsole from '@/app/admin/_components/admin-console';
import type { AdminConsoleInitialData } from '@/app/admin/_components/admin-initial-state';
import type {
  AccessKeySummary,
  CredentialSummary,
} from '@/app/admin/_components/admin-store';
import { listAccessKeys } from '@/lib/server/domain/access-keys';
import {
  getAdminSessionSummary,
  isAdminSessionAuthenticated,
} from '@/lib/server/admin/session';
import { getActiveConfig, getSettingLabels } from '@/lib/server/domain/config';
import { getDebugSettings, listDebugLogs } from '@/lib/server/domain/debug';
import {
  getCurrentCredentialInfo,
  listCredentials,
} from '@/lib/server/domain/credentials';
import { getUsageStats } from '@/lib/server/domain/stats';
import {
  defaultLocale,
  localeCookieName,
  locales,
  type AppLocale,
} from '@/lib/i18n/routing';
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

const resolveLocale = (cookieValue: string | undefined): AppLocale => {
  return locales.includes(cookieValue as AppLocale)
    ? (cookieValue as AppLocale)
    : defaultLocale;
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
    debugSettings,
    debugItems,
    activeConfig,
    stats,
  ] = await Promise.all([
    listAccessKeys(),
    buildApiEndpoint(),
    listCredentials(),
    getCurrentCredentialInfo(),
    getDebugSettings(),
    listDebugLogs(),
    getActiveConfig(),
    getUsageStats(),
  ]);

  return {
    accessKeys: accessKeys.access_keys as unknown as AccessKeySummary[],
    apiEndpoint,
    credentials: credentials.credentials as unknown as CredentialSummary[],
    currentCredential:
      currentCredential as unknown as AdminConsoleInitialData['currentCredential'],
    debug: {
      autoRefreshSeconds: debugSettings.autoRefreshSeconds,
      enabled: debugSettings.enabled,
      items: debugItems,
      maxEntries: debugSettings.maxEntries,
    },
    health: {
      checkedAtLabel: '',
      status: 'healthy',
      timestamp,
      uptimeText: '',
    },
    settings: {
      labels: getSettingLabels(locale),
      values: { ...activeConfig },
    },
    stats,
  };
};

const RootPage = async () => {
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

  if (
    session.accountConfigured &&
    !(await isAdminSessionAuthenticated(request))
  ) {
    redirect('/login');
  }

  const locale = resolveLocale(cookieStore.get(localeCookieName)?.value);

  return (
    <AdminConsole
      initialData={await getInitialData(locale)}
      initialTheme={parseThemeMode(cookieStore.get(themeCookieName)?.value)}
    />
  );
};

export default RootPage;
