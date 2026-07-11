import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import AdminConsole from '@/features/admin/admin-console';
import type { AdminConsoleInitialData } from '@/features/admin/admin-initial-state';
import type {
  AccessKeySummary,
  CredentialSummary,
} from '@/features/admin/admin-store';
import { getMessages } from '@/lib/i18n/messages';
import { defaultLocale, localeCookieName, locales } from '@/lib/i18n/routing';
import { listAccessKeys } from '@/lib/server/domain/access-keys';
import {
  getAdminSessionSummary,
  isAdminSessionAuthenticated,
} from '@/lib/server/admin/session';
import { SETTING_LABELS, getActiveConfig } from '@/lib/server/domain/config';
import { getDebugSettings, listDebugLogs } from '@/lib/server/domain/debug';
import {
  getCurrentCredentialInfo,
  listCredentials,
} from '@/lib/server/domain/credentials';
import { getUsageStats } from '@/lib/server/domain/stats';

export const dynamic = 'force-dynamic';

const resolveLocale = async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(localeCookieName)?.value;

  if (
    cookieLocale &&
    locales.includes(cookieLocale as (typeof locales)[number])
  ) {
    return cookieLocale;
  }

  return defaultLocale;
};

const buildApiEndpoint = async () => {
  const headerStore = await headers();
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';

  return `${protocol}://${host}/v1`;
};

const getInitialData = async (
  locale: string,
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
    messages,
  ] = await Promise.all([
    listAccessKeys(),
    buildApiEndpoint(),
    listCredentials(),
    getCurrentCredentialInfo(),
    getDebugSettings(),
    listDebugLogs(),
    getActiveConfig(),
    getUsageStats(),
    Promise.resolve(getMessages(locale as (typeof locales)[number])),
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
      labels: SETTING_LABELS,
      values: { ...activeConfig },
    },
    stats,
    translations: messages.Admin,
  };
};

const AdminPage = async () => {
  const locale = await resolveLocale();
  const headerStore = await headers();
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/admin`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  const session = await getAdminSessionSummary(request);

  if (
    session.accountConfigured &&
    !(await isAdminSessionAuthenticated(request))
  ) {
    redirect('/login');
  }

  return <AdminConsole initialData={await getInitialData(locale)} />;
};

export default AdminPage;
