import { atom } from 'jotai';

export type TabKey = 'dashboard' | 'credentials' | 'api-test' | 'settings';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface NotificationState {
  message: string;
  type: NotificationType;
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
  message: string;
  model: string;
  result: string;
  stream: boolean;
  submitting: boolean;
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
  { key: 'credentials', label: '凭证管理', icon: 'fas fa-key' },
  { key: 'api-test', label: 'API 测试', icon: 'fas fa-flask' },
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

export const USAGE_RING_CIRCUMFERENCE = 2 * Math.PI * 26;

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

export const themeAtom = atom<'light' | 'dark'>('light');

export const notificationAtom = atom<NotificationState | null>(null);

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
  message: 'Hello, what is 2+2?',
  model: 'glm-5.1',
  result: '点击"发送测试"查看API响应...',
  stream: false,
  submitting: false,
};

export const apiTestStateAtom = atom<ApiTestState>(defaultApiTestState);

export const defaultSettingsState: SettingsState = {
  labels: {},
  loading: true,
  saving: false,
  values: {},
};

export const settingsStateAtom = atom<SettingsState>(defaultSettingsState);
