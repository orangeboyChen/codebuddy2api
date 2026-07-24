import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn(),
}));

vi.mock('@/lib/server/domain/access-keys', () => ({
  listAccessKeys: vi.fn(),
}));

vi.mock('@/lib/server/domain/config', () => ({
  getActiveConfig: vi.fn(),
  getSettingLabels: vi.fn(),
}));

vi.mock('@/lib/server/domain/credentials', () => ({
  getCredentialSupportedModels: vi.fn(),
  getCurrentCredentialInfo: vi.fn(),
  listEligibleCredentialRecords: vi.fn(),
  listCredentials: vi.fn(),
}));

vi.mock('@/lib/server/proxy/codebuddy', () => ({
  getModelsByCredential: vi.fn(),
  getModelsForCredentials: vi.fn(),
}));

vi.mock('@/lib/server/domain/debug', () => ({
  getDebugSettings: vi.fn(),
  listDebugLogs: vi.fn(),
}));

vi.mock('@/lib/server/domain/stats', () => ({
  getUsageStats: vi.fn(),
}));

vi.mock('@/lib/server/domain/usage', () => ({
  getUsageAnalytics: vi.fn(),
}));

const { headers } = await import('next/headers');
const { listAccessKeys } = await import('@/lib/server/domain/access-keys');
const { getActiveConfig, getSettingLabels } =
  await import('@/lib/server/domain/config');
const {
  getCredentialSupportedModels,
  getCurrentCredentialInfo,
  listEligibleCredentialRecords,
  listCredentials,
} = await import('@/lib/server/domain/credentials');
const { getModelsByCredential, getModelsForCredentials } =
  await import('@/lib/server/proxy/codebuddy');
const { getDebugSettings, listDebugLogs } =
  await import('@/lib/server/domain/debug');
const { getUsageStats } = await import('@/lib/server/domain/stats');
const { getUsageAnalytics } = await import('@/lib/server/domain/usage');
const { getInitialData } = await import('@/app/page-loader');

const domainLoaders = {
  getActiveConfig,
  getCurrentCredentialInfo,
  getDebugSettings,
  getSettingLabels,
  getUsageAnalytics,
  getUsageStats,
  listAccessKeys,
  listCredentials,
  listEligibleCredentialRecords,
  listDebugLogs,
  getModelsByCredential,
  getModelsForCredentials,
};

describe('tab-scoped initial data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'admin.example.test' }) as never,
    );
    vi.mocked(listAccessKeys).mockResolvedValue({ access_keys: [] } as never);
    vi.mocked(getActiveConfig).mockResolvedValue({} as never);
    vi.mocked(getSettingLabels).mockReturnValue({} as never);
    vi.mocked(getCurrentCredentialInfo).mockResolvedValue({ status: 'empty' });
    vi.mocked(listCredentials).mockResolvedValue({ credentials: [] } as never);
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([]);
    vi.mocked(getCredentialSupportedModels).mockReturnValue([]);
    vi.mocked(getModelsForCredentials).mockResolvedValue([]);
    vi.mocked(getModelsByCredential).mockResolvedValue({});
    vi.mocked(getDebugSettings).mockResolvedValue({
      autoRefreshSeconds: 15,
      enabled: false,
      maxEntries: 100,
    } as never);
    vi.mocked(listDebugLogs).mockResolvedValue([]);
    vi.mocked(getUsageStats).mockResolvedValue({
      credential_usage: {},
      model_usage: {},
    } as never);
    vi.mocked(getUsageAnalytics).mockResolvedValue({} as never);
  });

  it.each([
    ['dashboard', ['getUsageAnalytics', 'listCredentials']],
    ['usage', ['getUsageAnalytics']],
    [
      'credentials',
      ['listAccessKeys', 'listCredentials', 'getCurrentCredentialInfo'],
    ],
    [
      'api-test',
      [
        'listCredentials',
        'getCurrentCredentialInfo',
        'listEligibleCredentialRecords',
        'getModelsForCredentials',
      ],
    ],
    ['debug', ['getDebugSettings', 'listDebugLogs']],
    ['settings', ['getActiveConfig', 'getSettingLabels']],
  ] as const)(
    'loads only the required domain data for %s',
    async (tab, expectedLoaders) => {
      const initialData = await getInitialData({ locale: 'en-US', tab });

      expect(initialData.tab).toBe(tab);
      expect(Object.keys(initialData).sort()).not.toEqual(
        expect.arrayContaining([
          'accessKeys',
          'apiEndpoint',
          'credentials',
          'currentCredential',
          'debug',
          'health',
          'settings',
          'stats',
          'usage',
        ]),
      );

      for (const [name, loader] of Object.entries(domainLoaders)) {
        expect(loader, name).toHaveBeenCalledTimes(
          (expectedLoaders as readonly string[]).includes(name) ? 1 : 0,
        );
      }
    },
  );

  it('hydrates API-test credential models from saved values', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      {
        data: { supported_models: 'glm-5.1' },
        filePath: '',
        filename: 'credential-a.json',
      },
    ] as never);
    vi.mocked(getCredentialSupportedModels).mockReturnValue(['glm-5.1']);

    const initialData = await getInitialData({
      locale: 'en-US',
      tab: 'api-test',
    });

    expect(initialData).toMatchObject({
      credentialModels: { 'credential-a.json': ['glm-5.1'] },
      tab: 'api-test',
    });
    expect(getModelsByCredential).not.toHaveBeenCalled();
  });

  it('restores persisted usage filters and refresh settings in the usage snapshot', async () => {
    vi.mocked(getUsageAnalytics).mockResolvedValue({
      callSeries: [],
      credentialRows: [],
      filters: { accessKeys: [], credentials: [] },
      range: 'today',
      rangeSummary: { cacheHitTokens: 0, callCount: 0, totalTokens: 0 },
      tableRows: [],
      tokenSeries: [],
    } as never);

    const usagePreferences = {
      accessKey: ['key-a'],
      autoRefreshSeconds: 30,
      credential: ['credential-a'],
      range: 'today' as const,
    };
    const initialData = await getInitialData({
      locale: 'en-US',
      tab: 'usage',
      usagePreferences,
    });

    expect(getUsageAnalytics).toHaveBeenCalledWith({
      accessKey: usagePreferences.accessKey,
      credential: usagePreferences.credential,
      range: usagePreferences.range,
    });
    expect(initialData).toMatchObject({
      tab: 'usage',
      usage: {
        autoRefreshSeconds: 30,
        request: {
          accessKey: usagePreferences.accessKey,
          credential: usagePreferences.credential,
          range: usagePreferences.range,
        },
      },
    });
  });
});
