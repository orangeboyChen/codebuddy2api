'use client';

import { atom } from 'jotai';
import { createContext, useContext } from 'react';

export type TabKey =
  'dashboard' | 'usage' | 'credentials' | 'api-test' | 'debug' | 'settings';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AdminSessionState {
  authenticated: boolean;
}

export interface CredentialSummary {
  index: number;
  filename: string;
  user_id: string;
  email: string;
  name: string | null;
  created_at: number | null;
  expires_in: number | null;
  expires_at: number | null;
  time_remaining: number | null;
  time_remaining_str: string;
  is_expired: boolean;
  token_type: string;
  scope: string | null;
  domain: string;
  responses_passthrough: boolean;
  first_message_role_to_system: boolean;
  enterprise_id: string | number | null;
  tenant_id: string | number | null;
  has_refresh_token: boolean;
  session_state: string | null;
}

export interface AccessKeySummary {
  createdAt: string;
  credentialFilenames: string[];
  id: string;
  maskedSecret: string;
  name: string;
  updatedAt: string;
}

export interface RevealedAccessKeySecret {
  id: string;
  name: string;
  secret: string;
}

export interface CurrentCredentialInfo {
  status: string;
  available_credential_count?: number;
  index?: number;
  filename?: string;
  next_filename?: string | null;
  user_id?: string;
  domain?: string;
  enterprise_id?: string | number | null;
  tenant_id?: string | number | null;
}

export interface DashboardState {
  apiEndpoint: string;
  credentialUsage: Array<[string, number]>;
  credentialUsagePercent: number;
  lastCheckedAt: string;
  loading: boolean;
  modelUsage: Array<[string, number]>;
  serviceStatus: 'online' | 'offline' | 'warning';
  statusText: string;
  totalApiCalls: number;
  totalCredentials: number;
  uptimeText: string;
  validCredentials: number;
}

export interface AuthState {
  authState: string;
  authUrl: string;
  callbackUrl: string;
  completed: boolean;
  intervalSeconds: number;
  message: string;
  polling: boolean;
  starting: boolean;
  showManualCallback: boolean;
}

export interface CredentialFormState {
  bearerToken: string;
  editingIndex: number | null;
  firstMessageRoleToSystem: boolean;
  responsesPassthrough: boolean;
  userId: string;
}

export interface AccessKeyFormState {
  credentialFilenames: string[];
  editingId: string | null;
  name: string;
}

export interface CredentialsState {
  accessKeyActionId: string | null;
  accessKeyForm: AccessKeyFormState;
  accessKeys: AccessKeySummary[];
  accessKeysLoading: boolean;
  actionIndex: number | null;
  current: CurrentCredentialInfo | null;
  currentLoading: boolean;
  form: CredentialFormState;
  items: CredentialSummary[];
  loading: boolean;
  revealedSecret: RevealedAccessKeySecret | null;
}

export interface ApiTestState {
  credentialFilename: string;
  message: string;
  model: string;
  result: string;
  stream: boolean;
  submitting: boolean;
}

export interface DebugLogEntry {
  credentialFilename: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: {
    body: unknown;
    headers: Record<string, string>;
    status: number;
  } | null;
  upstreamRequest: {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
  } | null;
  upstreamResponse: {
    body: unknown;
    headers: Record<string, string>;
    status: number;
  } | null;
}

export interface DebugState {
  autoRefreshSeconds: number;
  enabled: boolean;
  items: DebugLogEntry[];
  loading: boolean;
  maxEntries: number;
  saving: boolean;
}

export type UsageRange =
  '1h' | '3h' | '6h' | '12h' | '24h' | '3d' | '7d' | 'today' | 'yesterday';

export interface UsageBucketPoint {
  callCount: number;
  cacheHitTokens: number;
  label: string;
  start: string;
  totalTokens: number;
}

export interface UsageChartSeries {
  model: string;
  points: UsageBucketPoint[];
}

export interface UsageTableRow {
  callCount: number;
  cacheHitTokens: number;
  model: string;
  totalTokens: number;
}

export interface UsageFilterOption {
  label: string;
  value: string;
}

export interface UsageFiltersState {
  accessKey: string;
  credential: string;
  range: UsageRange;
}

export interface UsageState {
  autoRefreshSeconds: number;
  autoRefreshVisible: boolean;
  callSeries: UsageChartSeries[];
  filters: {
    accessKeys: UsageFilterOption[];
    credentials: UsageFilterOption[];
  };
  hoveredPoint: {
    chart: 'calls' | 'tokens';
    label: string;
    metricLabel: string;
    model: string;
    value: number;
    x: number;
    y: number;
  } | null;
  lastUpdatedAt: string;
  loading: boolean;
  request: UsageFiltersState;
  tableRows: UsageTableRow[];
  todaySummary: {
    cacheHitTokens: number;
    callCount: number;
    totalTokens: number;
  };
  tokenSeries: UsageChartSeries[];
}

export type SettingsValue = string | number | null;

export interface SettingsState {
  labels: Record<string, string>;
  loading: boolean;
  saving: boolean;
  values: Record<string, SettingsValue>;
}

export const TAB_ITEMS: Array<{ key: TabKey; label: string; icon: string }> = [
  { key: 'dashboard', label: '仪表板', icon: 'fas fa-tachometer-alt' },
  { key: 'usage', label: '用量统计', icon: 'fas fa-wave-square' },
  { key: 'credentials', label: '凭证管理', icon: 'fas fa-key' },
  { key: 'api-test', label: 'API 测试', icon: 'fas fa-flask' },
  { key: 'debug', label: 'Debug', icon: 'fas fa-bug' },
  { key: 'settings', label: '设置', icon: 'fas fa-cog' },
];

export const DEFAULT_TEST_MODELS = [
  'glm-5.1',
  'glm-5.0',
  'glm-5.0-turbo',
  'glm-5v-turbo',
  'glm-4.7',
  'minimax-m3-play',
  'minimax-m2.7',
  'minimax-m2.5',
  'kimi-k2.6',
  'kimi-k2.5',
  'hy3-preview-agent',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3-2-volc',
  'glm-5.1-ioa',
  'glm-5.0-ioa',
  'glm-5.0-turbo-ioa',
  'glm-5v-turbo-ioa',
  'glm-4.7-ioa',
  'minimax-m3-ioa',
  'minimax-m2.7-ioa',
  'minimax-m2.5-ioa',
  'kimi-k2.6-ioa',
  'kimi-k2.5-ioa',
  'hy3-preview-agent-ioa',
  'deepseek-v4-pro-ioa',
  'deepseek-v4-flash-ioa',
  'deepseek-v3-2-volc-ioa',
] as const;

export const USAGE_RING_CIRCUMFERENCE = 2 * Math.PI * 20;

export const defaultDashboardState: DashboardState = {
  apiEndpoint: '',
  credentialUsage: [],
  credentialUsagePercent: 0,
  lastCheckedAt: '',
  loading: true,
  modelUsage: [],
  serviceStatus: 'warning',
  statusText: '检查中',
  totalApiCalls: 0,
  totalCredentials: 0,
  uptimeText: '运行状态加载中...',
  validCredentials: 0,
};

export const dashboardStateAtom = atom<DashboardState>(defaultDashboardState);

export const activeTabAtom = atom<TabKey>('dashboard');

export const themeAtom = atom<ThemeMode>('system');

export const adminSessionAtom = atom<AdminSessionState | null>(null);

export const defaultAuthState: AuthState = {
  authState: '',
  authUrl: '',
  callbackUrl: '',
  completed: false,
  intervalSeconds: 5,
  message: '',
  polling: false,
  starting: false,
  showManualCallback: false,
};

export const authStateAtom = atom<AuthState>(defaultAuthState);

export const defaultCredentialsState: CredentialsState = {
  accessKeyActionId: null,
  accessKeyForm: {
    credentialFilenames: [],
    editingId: null,
    name: '',
  },
  accessKeys: [],
  accessKeysLoading: true,
  actionIndex: null,
  current: null,
  currentLoading: true,
  form: {
    bearerToken: '',
    editingIndex: null,
    firstMessageRoleToSystem: false,
    responsesPassthrough: false,
    userId: '',
  },
  items: [],
  loading: true,
  revealedSecret: null,
};

export const credentialsStateAtom = atom<CredentialsState>(
  defaultCredentialsState,
);

export const defaultApiTestState: ApiTestState = {
  credentialFilename: '',
  message: 'Hello, what is 2+2?',
  model: '',
  result: '',
  stream: false,
  submitting: false,
};

export const apiTestStateAtom = atom<ApiTestState>(defaultApiTestState);

export const defaultDebugState: DebugState = {
  autoRefreshSeconds: 0,
  enabled: false,
  items: [],
  loading: true,
  maxEntries: 100,
  saving: false,
};

export const debugStateAtom = atom<DebugState>(defaultDebugState);

export const defaultUsageState: UsageState = {
  autoRefreshSeconds: 15,
  autoRefreshVisible: true,
  callSeries: [],
  filters: {
    accessKeys: [],
    credentials: [],
  },
  hoveredPoint: null,
  lastUpdatedAt: '',
  loading: true,
  request: {
    accessKey: 'all',
    credential: 'all',
    range: '24h',
  },
  tableRows: [],
  todaySummary: {
    cacheHitTokens: 0,
    callCount: 0,
    totalTokens: 0,
  },
  tokenSeries: [],
};

export const usageStateAtom = atom<UsageState>(defaultUsageState);

export const defaultSettingsState: SettingsState = {
  labels: {},
  loading: true,
  saving: false,
  values: {},
};

export const settingsStateAtom = atom<SettingsState>(defaultSettingsState);

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
  updatedAtLabel: string;
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
    statusText: initialData.health.status === 'healthy' ? 'online' : 'offline',
    totalApiCalls,
    totalCredentials: initialData.credentials.length,
    uptimeText:
      initialData.health.uptimeText ||
      initialData.health.checkedAtLabel ||
      initialData.health.timestamp,
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
    lastUpdatedAt: initialData.usage?.updatedAtLabel ?? '',
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

export const createApiTestState = (
  initialData: AdminConsoleInitialData,
): ApiTestState => {
  const validCredentials = initialData.credentials.filter(
    (credential) => !credential.is_expired,
  );
  const currentCredential = validCredentials.find(
    (credential) =>
      credential.filename === initialData.currentCredential.filename,
  );

  return {
    credentialFilename:
      currentCredential?.filename ?? validCredentials[0]?.filename ?? '',
    message: 'Hello, what is 2+2?',
    model: '',
    result: '',
    stream: false,
    submitting: false,
  };
};

export interface CredentialsTabContextValue {
  auth: AuthState;
  credentials: CredentialsState;
  onAddCredential: () => void;
  onAuthAction: () => void;
  onCallbackUrlChange: (value: string) => void;
  onCopyAuthUrl: () => void;
  onCredentialFirstMessageRoleToSystemChange: (value: boolean) => void;
  onCredentialResponsesPassthroughChange: (value: boolean) => void;
  onCredentialTokenChange: (value: string) => void;
  onCredentialUserIdChange: (value: string) => void;
  onDeleteCredential: (index: number) => void;
  onDeleteAccessKey: (id: string) => void;
  onEditCredential: (credential: CredentialSummary) => void;
  onEditAccessKey: (accessKey: AccessKeySummary) => void;
  onOpenAuthUrl: () => void;
  onPollAuth: () => void;
  onRefreshAccessKeys: () => void;
  onRefreshCredentialList: () => void;
  onResetCredentialForm: () => void;
  onResetAccessKeyForm: () => void;
  onRevealAccessKeySecret: (id: string) => void;
  onSaveAccessKey: () => void;
  onSubmitCallbackUrl: () => void;
  onToggleCallbackMode: (showManual: boolean) => void;
  onToggleCredentialSelection: (filename: string) => void;
  onUpdateAccessKeyName: (value: string) => void;
}

interface DashboardTabContextValue {
  dashboard: DashboardState;
  onCopyEndpoint: () => void;
  onRefresh: () => void;
}

const DashboardTabContext = createContext<DashboardTabContextValue | null>(
  null,
);

export const DashboardTabProvider = DashboardTabContext.Provider;

export const useDashboardTab = (): DashboardTabContextValue => {
  const context = useContext(DashboardTabContext);

  if (!context) {
    throw new Error('Dashboard tab must be rendered inside AdminConsole');
  }

  return context;
};

interface UsageTabContextValue {
  onAccessKeyChange: (value: string) => void;
  onAutoRefreshSecondsChange: (value: number) => void;
  onClearHistory: () => void;
  onCredentialChange: (value: string) => void;
  onHoverPoint: (point: UsageState['hoveredPoint']) => void;
  onRangeChange: (value: UsageRange) => void;
  onRefresh: () => void;
  usage: UsageState;
}

const UsageTabContext = createContext<UsageTabContextValue | null>(null);

export const UsageTabProvider = UsageTabContext.Provider;

export const useUsageTab = (): UsageTabContextValue => {
  const context = useContext(UsageTabContext);

  if (!context) {
    throw new Error('Usage tab must be rendered inside AdminConsole');
  }

  return context;
};

interface DebugTabContextValue {
  autoRefreshOptions: Array<{ label: string; value: number }>;
  debug: DebugState;
  onAutoRefreshSecondsChange: (value: number) => void;
  onClear: () => void;
  onCopy: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onMaxEntriesChange: (value: number) => void;
  onRefresh: () => void;
  onSave: () => void;
}

const DebugTabContext = createContext<DebugTabContextValue | null>(null);

export const DebugTabProvider = DebugTabContext.Provider;

export const useDebugTab = (): DebugTabContextValue => {
  const context = useContext(DebugTabContext);

  if (!context)
    throw new Error('Debug tab must be rendered inside AdminConsole');

  return context;
};

interface SettingsTabContextValue {
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  settings: SettingsState;
}

const SettingsTabContext = createContext<SettingsTabContextValue | null>(null);

export const SettingsTabProvider = SettingsTabContext.Provider;

export const useSettingsTab = (): SettingsTabContextValue => {
  const context = useContext(SettingsTabContext);

  if (!context) {
    throw new Error('Settings tab must be rendered inside AdminConsole');
  }

  return context;
};

interface ApiTestTabContextValue {
  apiTest: ApiTestState;
  credentialOptions: CredentialSummary[];
  models: string[];
  onCredentialChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onStreamChange: (value: boolean) => void;
  onSubmit: () => void;
}

const ApiTestTabContext = createContext<ApiTestTabContextValue | null>(null);

export const ApiTestTabProvider = ApiTestTabContext.Provider;

export const useApiTestTab = (): ApiTestTabContextValue => {
  const context = useContext(ApiTestTabContext);

  if (!context)
    throw new Error('API test tab must be rendered inside AdminConsole');

  return context;
};

const CredentialsTabContext = createContext<CredentialsTabContextValue | null>(
  null,
);

export const CredentialsTabProvider = CredentialsTabContext.Provider;

export const useCredentialsTab = (): CredentialsTabContextValue => {
  const context = useContext(CredentialsTabContext);

  if (!context) {
    throw new Error('Credentials tab must be rendered inside the admin page');
  }

  return context;
};
