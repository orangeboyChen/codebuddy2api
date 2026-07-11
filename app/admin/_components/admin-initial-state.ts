import type {
  AccessKeySummary,
  CredentialsState,
  CredentialSummary,
  CurrentCredentialInfo,
  DebugState,
  DashboardState,
  SettingsState,
  UsageState,
  UsageChartSeries,
  UsageFilterOption,
  UsageRange,
  UsageTableRow,
} from '@/app/admin/_components/admin-store';

export interface AdminHealthState {
  checkedAtLabel: string;
  status: string;
  timestamp: string;
  uptimeText: string;
}

export interface AdminStatsState {
  credential_usage: Record<string, number>;
  model_usage: Record<string, number>;
}

export interface AdminSettingsSnapshot {
  labels: Record<string, string>;
  values: Record<string, string | number | null>;
}

export interface AdminDebugSnapshot {
  autoRefreshSeconds: number;
  enabled: boolean;
  items: DebugState['items'];
  maxEntries: number;
}

export interface AdminUsageSnapshot {
  callSeries: UsageChartSeries[];
  filters: {
    accessKeys: UsageFilterOption[];
    credentials: UsageFilterOption[];
  };
  range: UsageRange;
  tableRows: UsageTableRow[];
  todaySummary: UsageState['todaySummary'];
  tokenSeries: UsageChartSeries[];
}

export interface AdminConsoleInitialData {
  accessKeys: AccessKeySummary[];
  apiEndpoint: string;
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
  debug: AdminDebugSnapshot;
  health: AdminHealthState;
  settings: AdminSettingsSnapshot;
  stats: AdminStatsState;
  usage?: AdminUsageSnapshot;
}

export const createDashboardState = (
  initialData: AdminConsoleInitialData,
): DashboardState => {
  const validCredentials = initialData.credentials.filter(
    (item) => !item.is_expired,
  ).length;
  const totalApiCalls = Object.values(initialData.stats.model_usage).reduce(
    (total, count) => total + count,
    0,
  );
  const credentialUsagePercent = initialData.credentials.length
    ? (validCredentials / initialData.credentials.length) * 100
    : 0;

  return {
    apiEndpoint: initialData.apiEndpoint,
    credentialUsage: Object.entries(initialData.stats.credential_usage).sort(
      (left, right) => right[1] - left[1],
    ),
    credentialUsagePercent,
    lastCheckedAt: initialData.health.checkedAtLabel,
    loading: false,
    modelUsage: Object.entries(initialData.stats.model_usage).sort(
      (left, right) => right[1] - left[1],
    ),
    serviceStatus:
      initialData.health.status === 'healthy' ? 'online' : 'offline',
    statusText: initialData.health.status === 'healthy' ? '运行中' : '不可用',
    totalApiCalls,
    totalCredentials: initialData.credentials.length,
    uptimeText: initialData.health.uptimeText,
    validCredentials,
  };
};

export const createCredentialsState = (
  initialData: AdminConsoleInitialData,
): CredentialsState => {
  return {
    accessKeyActionId: null,
    accessKeyForm: {
      credentialFilenames: [],
      editingId: null,
      name: '',
    },
    accessKeys: initialData.accessKeys,
    accessKeysLoading: false,
    actionIndex: null,
    current: initialData.currentCredential,
    currentLoading: false,
    form: {
      bearerToken: '',
      editingIndex: null,
      firstMessageRoleToSystem: false,
      responsesPassthrough: false,
      userId: '',
    },
    items: initialData.credentials,
    loading: false,
    revealedSecret: null,
  };
};

export const createSettingsState = (
  initialData: AdminConsoleInitialData,
): SettingsState => {
  return {
    labels: initialData.settings.labels,
    loading: false,
    saving: false,
    values: initialData.settings.values,
  };
};

export const createDebugState = (
  initialData: AdminConsoleInitialData,
): DebugState => {
  return {
    autoRefreshSeconds: initialData.debug.autoRefreshSeconds,
    enabled: initialData.debug.enabled,
    items: initialData.debug.items,
    loading: false,
    maxEntries: initialData.debug.maxEntries,
    saving: false,
  };
};

export const createUsageState = (
  initialData: AdminConsoleInitialData,
): UsageState => {
  return {
    autoRefreshSeconds: 15,
    autoRefreshVisible: true,
    callSeries: initialData.usage?.callSeries ?? [],
    filters: initialData.usage?.filters ?? {
      accessKeys: [],
      credentials: [],
    },
    hoveredPoint: null,
    lastUpdatedAt: '',
    loading: false,
    request: {
      accessKey: 'all',
      credential: 'all',
      range: initialData.usage?.range ?? '24h',
    },
    tableRows: initialData.usage?.tableRows ?? [],
    todaySummary: initialData.usage?.todaySummary ?? {
      cacheHitTokens: 0,
      callCount: 0,
      totalTokens: 0,
    },
    tokenSeries: initialData.usage?.tokenSeries ?? [],
  };
};
