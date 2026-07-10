import { headers } from 'next/headers';

import AdminConsole from '@/app/admin/_components/admin-console';
import type { AdminConsoleInitialData } from '@/app/admin/_components/admin-initial-state';
import type {
  AccessKeySummary,
  CredentialSummary,
} from '@/app/admin/_components/admin-store';
import { listAccessKeys } from '@/lib/server/access-keys';
import { SETTING_LABELS, getActiveConfig } from '@/lib/server/config';
import { getDebugSettings, listDebugLogs } from '@/lib/server/debug';
import {
  getCurrentCredentialInfo,
  listCredentials,
} from '@/lib/server/credentials';
import { getUsageStats } from '@/lib/server/stats';

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

const getInitialData = async (): Promise<AdminConsoleInitialData> => {
  const timestamp = new Date().toISOString();
  const debugSettings = getDebugSettings();

  return {
    accessKeys: listAccessKeys().access_keys as unknown as AccessKeySummary[],
    apiEndpoint: await buildApiEndpoint(),
    credentials: listCredentials()
      .credentials as unknown as CredentialSummary[],
    currentCredential:
      getCurrentCredentialInfo() as unknown as AdminConsoleInitialData['currentCredential'],
    debug: {
      autoRefreshSeconds: debugSettings.autoRefreshSeconds,
      enabled: debugSettings.enabled,
      items: listDebugLogs(),
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
      values: { ...getActiveConfig() },
    },
    stats: getUsageStats(),
  };
};

const HomePage = async () => {
  return <AdminConsole initialData={await getInitialData()} />;
};

export default HomePage;
