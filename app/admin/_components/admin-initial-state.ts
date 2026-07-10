import type {
  AccessKeySummary,
  CredentialsState,
  CredentialSummary,
  CurrentCredentialInfo,
  DashboardState,
  SettingsState,
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

export interface AdminConsoleInitialData {
  accessKeys: AccessKeySummary[];
  apiEndpoint: string;
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
  health: AdminHealthState;
  settings: AdminSettingsSnapshot;
  stats: AdminStatsState;
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
