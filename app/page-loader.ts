import { headers } from 'next/headers';

import type {
  AccessKeySummary,
  CredentialSummary,
  CurrentCredentialInfo,
} from '@/app/credentials/credentials';
import type {
  AdminConsoleInitialData,
  AdminSettingsSnapshot,
  TabKey,
} from '@/app/page-data';
import type { UsageFiltersState } from '@/app/usage/usage';
import type { AdminUsagePreferences } from '@/lib/server/admin/session';
import { listAccessKeys } from '@/lib/server/domain/access-keys';
import { getActiveConfig, getSettingLabels } from '@/lib/server/domain/config';
import {
  getCurrentCredentialInfo,
  listCredentials,
} from '@/lib/server/domain/credentials';
import { getDebugSettings, listDebugLogs } from '@/lib/server/domain/debug';
import { getUsageAnalytics } from '@/lib/server/domain/usage';
import type { AppLocale } from '@/lib/i18n/routing';

const defaultUsageRequest: UsageFiltersState = {
  accessKey: [],
  credential: [],
  range: '24h',
};

export interface InitialDataRequest {
  locale: AppLocale;
  tab: TabKey;
  usagePreferences?: AdminUsagePreferences | null;
}

const buildApiEndpoint = async () => {
  const headerStore = await headers();
  const protocol = headerStore.get('x-forwarded-proto') ?? 'http';
  const host =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    'localhost';

  return `${protocol}://${host}/v1`;
};

const createDebugSnapshot = async () => {
  const [debugSettings, debugLogs] = await Promise.all([
    getDebugSettings(),
    listDebugLogs(),
  ]);

  return {
    autoRefreshSeconds: debugSettings.autoRefreshSeconds,
    enabled: debugSettings.enabled,
    items: debugLogs.map((log) => ({
      credentialFilename: log.credentialFilename,
      createdAt: log.createdAt,
      elapsedMs: log.elapsedMs,
      error: log.error,
      id: log.id,
      model: log.model,
      requestBody: null,
      requestKey: log.requestKey,
      route: log.route,
      transformedResponse: log.transformedResponse
        ? { body: null, headers: {}, status: log.transformedResponse.status }
        : null,
      upstreamRequest: log.upstreamRequest
        ? { method: log.upstreamRequest.method, url: log.upstreamRequest.url }
        : null,
      upstreamResponse: log.upstreamResponse
        ? { body: null, headers: {}, status: log.upstreamResponse.status }
        : null,
      usage: log.usage,
    })),
    maxEntries: debugSettings.maxEntries,
  };
};

export const getInitialData = async ({
  locale,
  tab,
  usagePreferences,
}: InitialDataRequest): Promise<AdminConsoleInitialData> => {
  switch (tab) {
    case 'dashboard': {
      const [apiEndpoint, credentials, usage] = await Promise.all([
        buildApiEndpoint(),
        listCredentials(),
        getUsageAnalytics({ range: 'today' }),
      ]);

      return {
        apiEndpoint,
        tab,
        totalCredentials: credentials.credentials.length,
        validCredentials: credentials.credentials.filter(
          (credential) => !credential.is_expired,
        ).length,
        usage: { rangeSummary: usage.rangeSummary },
      };
    }
    case 'usage': {
      const timestamp = new Date().toISOString();
      const usageRequest: UsageFiltersState = usagePreferences
        ? {
            accessKey: usagePreferences.accessKey,
            credential: usagePreferences.credential,
            range: usagePreferences.range,
          }
        : defaultUsageRequest;
      const usage = await getUsageAnalytics(usageRequest);

      return {
        tab,
        usage: {
          ...usage,
          autoRefreshSeconds: usagePreferences?.autoRefreshSeconds ?? 15,
          request: usageRequest,
          updatedAtLabel: new Date(timestamp).toLocaleTimeString(locale),
        },
      };
    }
    case 'credentials': {
      const [accessKeys, credentials, currentCredential] = await Promise.all([
        listAccessKeys(),
        listCredentials(),
        getCurrentCredentialInfo(),
      ]);

      return {
        accessKeys: accessKeys.access_keys as unknown as AccessKeySummary[],
        credentials: credentials.credentials as unknown as CredentialSummary[],
        currentCredential:
          currentCredential as unknown as CurrentCredentialInfo,
        tab,
      };
    }
    case 'api-test': {
      const [credentials, currentCredential, config] = await Promise.all([
        listCredentials(),
        getCurrentCredentialInfo(),
        getActiveConfig(),
      ]);

      return {
        credentials: credentials.credentials as unknown as CredentialSummary[],
        currentCredential:
          currentCredential as unknown as CurrentCredentialInfo,
        modelSettings: config.CODEBUDDY_MODELS,
        tab,
      };
    }
    case 'debug':
      return { debug: await createDebugSnapshot(), tab };
    case 'settings': {
      const settings: AdminSettingsSnapshot = {
        labels: getSettingLabels(locale),
        values: { ...(await getActiveConfig()) },
      };

      return { settings, tab };
    }
  }
};
