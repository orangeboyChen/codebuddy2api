'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createStore, Provider, useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Button } from '@lobehub/ui';
import { ToastHost, toast } from '@lobehub/ui/base-ui';
import { LogOut } from 'lucide-react';

import {
  createApiTestState,
  createCredentialsState,
  createDebugState,
  createDashboardState,
  createSettingsState,
  createUsageState,
  type AdminConsoleInitialData,
} from '@/app/admin/_components/admin-initial-state';
import {
  ApiTestSection,
  CredentialsSection,
  DebugSection,
  DashboardSection,
  SettingsSection,
  TabNav,
  UsageSection,
} from '@/app/admin/_components/admin-sections';
import {
  adminTabPaths,
  adminSessionAtom,
  apiTestStateAtom,
  authStateAtom,
  type AccessKeySummary,
  type CredentialSummary,
  credentialsStateAtom,
  debugStateAtom,
  dashboardStateAtom,
  DEFAULT_TEST_MODELS,
  defaultApiTestState,
  defaultAuthState,
  defaultCredentialsState,
  defaultDebugState,
  defaultDashboardState,
  defaultSettingsState,
  defaultUsageState,
  type TabKey,
  settingsStateAtom,
  themeAtom,
  type ThemeMode,
  type UsageChartSeries,
  type UsageFilterOption,
  type UsageFiltersState,
  type UsageRange,
  usageStateAtom,
} from '@/app/admin/_components/admin-store';
import { AdminHeader } from '@/app/_components/admin-header';
import {
  resolvedThemeCookieName,
  themeChangeEventName,
  themeCookieName,
} from '@/lib/theme';
import {
  localeCookieName,
  localePreferenceCookieName,
  type LocalePreference,
  systemLocalePreference,
} from '@/lib/i18n/routing';

interface HealthResponse {
  status?: string;
  timestamp?: string;
}

interface CredentialsResponse {
  credentials?: CredentialSummary[];
}

interface AccessKeysResponse {
  access_keys?: AccessKeySummary[];
}

interface AccessKeySecretResponse {
  id?: string;
  name?: string;
  secret?: string;
}

interface CurrentCredentialResponse {
  available_credential_count?: number;
  filename?: string;
  index?: number;
  next_filename?: string | null;
  status?: string;
  user_id?: string;
}

interface StatsResponse {
  credential_usage?: Record<string, number>;
  model_usage?: Record<string, number>;
}

interface UsageResponse {
  callSeries?: UsageChartSeries[];
  filters?: {
    accessKeys?: UsageFilterOption[];
    credentials?: UsageFilterOption[];
  };
  range?: UsageRange;
  tableRows?: Array<{
    callCount?: number;
    cacheHitTokens?: number;
    model?: string;
    totalTokens?: number;
  }>;
  todaySummary?: {
    cacheHitTokens?: number;
    callCount?: number;
    totalTokens?: number;
  };
  tokenSeries?: UsageChartSeries[];
}

interface StartAuthResponse {
  auth_state?: string;
  error?: string;
  expires_in?: number;
  interval?: number;
  message?: string;
  success?: boolean;
  verification_uri_complete?: string;
}

interface PollAuthResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  filename?: string;
  message?: string;
}

interface SettingsResponse {
  labels?: Record<string, string>;
  settings?: Record<string, string | number | null>;
}

interface DebugResponse {
  autoRefreshSeconds?: number;
  enabled?: boolean;
  items?: Array<
    typeof defaultDebugState.items extends Array<infer Item> ? Item : never
  >;
  maxEntries?: number;
  message?: string;
}

interface ApiTestSuccess {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    message?: {
      content?: unknown;
    };
  }>;
}

interface JsonResult<T> {
  data: T | null;
  ok: boolean;
  status: number;
}

const requestJson = async <T,>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<JsonResult<T>> => {
  const response = await fetch(input, init);
  const text = await response.text();

  if (!text.trim()) {
    return {
      data: null,
      ok: response.ok,
      status: response.status,
    };
  }

  try {
    return {
      data: JSON.parse(text) as T,
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      data: null,
      ok: response.ok,
      status: response.status,
    };
  }
};

const getErrorMessage = (payload: unknown, fallback: string) => {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const message =
    (payload as Record<string, unknown>).message ??
    (payload as Record<string, unknown>).error_description ??
    (payload as Record<string, unknown>).error;

  return typeof message === 'string' && message.trim() ? message : fallback;
};

const buildApiEndpoint = () => {
  if (typeof window === 'undefined') {
    return 'http://127.0.0.1:8001/v1';
  }

  return `${window.location.origin}/v1`;
};

const getConfiguredModels = (rawValue: string | number | null | undefined) => {
  return String(rawValue ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const formatResult = (payload: unknown) => {
  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return 'Unable to render response.';
  }
};

const getSseEventContent = (event: string) => {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');

  if (!data || data === '[DONE]') {
    return '';
  }

  try {
    const payload = JSON.parse(data) as ApiTestSuccess;
    const content =
      payload.choices?.[0]?.delta?.content ??
      payload.choices?.[0]?.message?.content;

    return typeof content === 'string' ? content : '';
  } catch {
    return data;
  }
};

interface AdminConsoleProps {
  initialData?: AdminConsoleInitialData;
  initialLocalePreference: LocalePreference;
  initialTab: TabKey;
  initialTheme?: ThemeMode;
}

const AdminConsoleContent = ({
  initialData,
  initialLocalePreference,
  initialTab,
  initialTheme = 'system',
}: AdminConsoleProps) => {
  const router = useRouter();
  const initialDashboardState = initialData
    ? createDashboardState(initialData)
    : defaultDashboardState;
  const initialCredentialsState = initialData
    ? createCredentialsState(initialData)
    : defaultCredentialsState;
  const initialDebugState = initialData
    ? createDebugState(initialData)
    : defaultDebugState;
  const initialUsageState = initialData
    ? createUsageState(initialData)
    : defaultUsageState;
  const initialSettingsState = initialData
    ? createSettingsState(initialData)
    : defaultSettingsState;
  const initialApiTestState = initialData
    ? createApiTestState(initialData)
    : defaultApiTestState;

  useHydrateAtoms([
    [dashboardStateAtom, initialDashboardState],
    [credentialsStateAtom, initialCredentialsState],
    [debugStateAtom, initialDebugState],
    [usageStateAtom, initialUsageState],
    [settingsStateAtom, initialSettingsState],
    [authStateAtom, defaultAuthState],
    [apiTestStateAtom, initialApiTestState],
    [themeAtom, initialTheme],
  ]);

  const [theme, setTheme] = useAtom(themeAtom);
  const [dashboard, setDashboard] = useAtom(dashboardStateAtom);
  const [credentials, setCredentials] = useAtom(credentialsStateAtom);
  const [debug, setDebug] = useAtom(debugStateAtom);
  const [usage, setUsage] = useAtom(usageStateAtom);
  const [auth, setAuth] = useAtom(authStateAtom);
  const [apiTest, setApiTest] = useAtom(apiTestStateAtom);
  const [settings, setSettings] = useAtom(settingsStateAtom);
  const [adminSession, setAdminSession] = useAtom(adminSessionAtom);
  const activeTab = initialTab;
  const locale = useLocale();
  const translations = useTranslations('Admin');
  const consoleText = {
    'en-US': {
      apiKeyCreated: 'API key created.',
      apiKeyDeleted: 'API key deleted.',
      apiKeyDeleteFailed: 'Failed to delete API key.',
      apiKeyDisplayed: 'API key revealed.',
      apiKeyReadFailed: 'Failed to read API key.',
      apiKeyUpdated: 'API key updated.',
      authCheckMissing: 'Missing auth state; cannot continue polling.',
      authChecking: 'Checking authentication status...',
      authCopy: 'Authorization link copied.',
      authCreated: 'Authorization link created.',
      authInvalidCallback: 'The callback URL is invalid.',
      authLinkMissing: 'The authorization link has not been created yet.',
      authPending: 'Waiting for authentication...',
      authPollFailed: 'Authentication polling failed.',
      authSaved: 'Authentication succeeded and the credential was saved.',
      authStarted: 'Complete sign-in and the console will keep polling.',
      authStartFailed: 'Failed to start authentication.',
      authSuccess: 'Authentication succeeded.',
      clipboardEmpty: 'Nothing to copy.',
      clipboardUnsupported: 'Clipboard is not available in this environment.',
      copyContent: 'Content copied.',
      copyEndpoint: 'API endpoint copied.',
      credentialDeleteFailed: 'Failed to delete credential.',
      credentialDeleted: 'Credential deleted.',
      credentialRequired: 'Bearer token is required.',
      credentialSaveFailed: 'Failed to save credential.',
      credentialSaved: (name: string) => `Credential saved: ${name}`,
      debugClearFailed: 'Failed to clear debug records.',
      debugCleared: 'Debug records cleared.',
      debugLoadFailed: 'Failed to load debug records.',
      debugSaveFailed: 'Failed to save debug settings.',
      debugSaved: 'Debug settings saved.',
      requestSending: 'Sending request...',
      requestIdle: 'Click "Send test" to view the API response...',
      requestFailed: 'API test failed.',
      settingsSaveFailed: 'Failed to save settings.',
      settingsSaved: 'Settings saved.',
      serviceCheckedAt: 'Last checked',
      serviceRunning: 'Running',
      serviceUnavailable: 'Unavailable',
      usageCleared: 'Usage history cleared.',
      usageClearFailed: 'Failed to clear usage history.',
      usageLoadFailed: 'Failed to load usage data.',
      uptimeRefreshed: 'Status refreshed',
    },
    'ja-JP': {
      apiKeyCreated: 'API key を作成しました。',
      apiKeyDeleted: 'API key を削除しました。',
      apiKeyDeleteFailed: 'API key の削除に失敗しました。',
      apiKeyDisplayed: 'API key を表示しました。',
      apiKeyReadFailed: 'API key の読み取りに失敗しました。',
      apiKeyUpdated: 'API key を更新しました。',
      authCheckMissing: '認証状態がないため、ポーリングを続行できません。',
      authChecking: '認証状態を確認しています...',
      authCopy: '認証リンクをコピーしました。',
      authCreated: '認証リンクを生成しました。',
      authInvalidCallback: 'コールバック URL の形式が正しくありません。',
      authLinkMissing: '認証リンクはまだ生成されていません。',
      authPending: '認証完了を待っています...',
      authPollFailed: '認証ポーリングに失敗しました。',
      authSaved: '認証に成功し、認証情報を保存しました。',
      authStarted:
        'サインインを完了するとコンソールが自動的に結果を確認します。',
      authStartFailed: '認証開始に失敗しました。',
      authSuccess: '認証に成功しました。',
      clipboardEmpty: 'コピーできる内容がありません。',
      clipboardUnsupported: 'この環境ではクリップボードを利用できません。',
      copyContent: '内容をコピーしました。',
      copyEndpoint: 'API エンドポイントをコピーしました。',
      credentialDeleteFailed: '認証情報の削除に失敗しました。',
      credentialDeleted: '認証情報を削除しました。',
      credentialRequired: 'Bearer Token を入力してください。',
      credentialSaveFailed: '認証情報の保存に失敗しました。',
      credentialSaved: (name: string) => `認証情報を保存しました: ${name}`,
      debugClearFailed: 'Debug 記録の削除に失敗しました。',
      debugCleared: 'Debug 記録を削除しました。',
      debugLoadFailed: 'Debug 記録の読み込みに失敗しました。',
      debugSaveFailed: 'Debug 設定の保存に失敗しました。',
      debugSaved: 'Debug 設定を保存しました。',
      requestSending: 'リクエスト送信中...',
      requestIdle: '「送信テスト」をクリックすると API 応答を表示します...',
      requestFailed: 'API テストに失敗しました。',
      settingsSaveFailed: '設定の保存に失敗しました。',
      settingsSaved: '設定を保存しました。',
      serviceCheckedAt: '最終確認',
      serviceRunning: '稼働中',
      serviceUnavailable: '利用不可',
      usageCleared: '使用量履歴を削除しました。',
      usageClearFailed: '使用量履歴の削除に失敗しました。',
      usageLoadFailed: '使用量データの読み込みに失敗しました。',
      uptimeRefreshed: '状態を更新しました',
    },
    'zh-CN': {
      apiKeyCreated: 'API Key 已生成。',
      apiKeyDeleted: 'API Key 已删除。',
      apiKeyDeleteFailed: '删除 API Key 失败。',
      apiKeyDisplayed: 'API Key 已显示。',
      apiKeyReadFailed: '读取 API Key 失败。',
      apiKeyUpdated: 'API Key 已更新。',
      authCheckMissing: '缺少认证状态，无法继续轮询。',
      authChecking: '正在检查认证状态...',
      authCopy: '认证链接已复制。',
      authCreated: '认证链接已生成。',
      authInvalidCallback: '回调链接格式不正确。',
      authLinkMissing: '认证链接还未生成。',
      authPending: '等待认证完成...',
      authPollFailed: '认证轮询失败。',
      authSaved: '认证成功，凭证已保存。',
      authStarted: '请完成登录，系统会自动轮询结果。',
      authStartFailed: '启动认证失败。',
      authSuccess: '认证成功！',
      clipboardEmpty: '没有可复制的内容。',
      clipboardUnsupported: '当前环境不支持剪贴板。',
      copyContent: '内容已复制。',
      copyEndpoint: 'API 端点已复制。',
      credentialDeleteFailed: '删除凭证失败。',
      credentialDeleted: '凭证已删除。',
      credentialRequired: 'Bearer Token 不能为空。',
      credentialSaveFailed: '添加凭证失败。',
      credentialSaved: (name: string) => `凭证已保存：${name}`,
      debugClearFailed: '清空 Debug 记录失败。',
      debugCleared: 'Debug 记录已清空。',
      debugLoadFailed: '加载 Debug 记录失败。',
      debugSaveFailed: '保存 Debug 设置失败。',
      debugSaved: 'Debug 设置已保存。',
      requestSending: '请求发送中...',
      requestIdle: '点击“发送测试”查看 API 响应...',
      requestFailed: 'API 测试失败。',
      settingsSaveFailed: '保存设置失败。',
      settingsSaved: '设置已保存。',
      serviceCheckedAt: '最后检查',
      serviceRunning: '运行中',
      serviceUnavailable: '不可用',
      usageCleared: '用量统计历史已清空。',
      usageClearFailed: '清空用量统计历史失败。',
      usageLoadFailed: '加载用量统计数据失败。',
      uptimeRefreshed: '状态已刷新',
    },
  }[locale as 'zh-CN' | 'en-US' | 'ja-JP'];
  const debugAutoRefreshOptions = [
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: off'
          : locale === 'ja-JP'
            ? '自動更新: オフ'
            : '自动刷新：关闭',
      value: 0,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 5 sec'
          : locale === 'ja-JP'
            ? '自動更新: 5 秒'
            : '自动刷新：5 秒',
      value: 5,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 10 sec'
          : locale === 'ja-JP'
            ? '自動更新: 10 秒'
            : '自动刷新：10 秒',
      value: 10,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 15 sec'
          : locale === 'ja-JP'
            ? '自動更新: 15 秒'
            : '自动刷新：15 秒',
      value: 15,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 30 sec'
          : locale === 'ja-JP'
            ? '自動更新: 30 秒'
            : '自动刷新：30 秒',
      value: 30,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 1 min'
          : locale === 'ja-JP'
            ? '自動更新: 1 分'
            : '自动刷新：1 分钟',
      value: 60,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 2 min'
          : locale === 'ja-JP'
            ? '自動更新: 2 分'
            : '自动刷新：2 分钟',
      value: 120,
    },
    {
      label:
        locale === 'en-US'
          ? 'Auto-refresh: 5 min'
          : locale === 'ja-JP'
            ? '自動更新: 5 分'
            : '自动刷新：5 分钟',
      value: 300,
    },
  ] as const;
  const authPollTimerRef = useRef<number | null>(null);
  const debugAutoRefreshTimerRef = useRef<number | null>(null);
  const usageAutoRefreshTimerRef = useRef<number | null>(null);
  const usageRequestRef = useRef(usage.request);
  const showNotification = useCallback(
    (type: 'success' | 'error' | 'warning' | 'info', message: string) => {
      toast[type]({ description: message, duration: 3000 });
    },
    [],
  );

  const clearAuthTimer = () => {
    if (authPollTimerRef.current !== null) {
      window.clearTimeout(authPollTimerRef.current);
      authPollTimerRef.current = null;
    }
  };

  const clearDebugAutoRefreshTimer = useCallback(() => {
    if (debugAutoRefreshTimerRef.current !== null) {
      window.clearInterval(debugAutoRefreshTimerRef.current);
      debugAutoRefreshTimerRef.current = null;
    }
  }, []);

  const clearUsageTimer = () => {
    if (usageAutoRefreshTimerRef.current !== null) {
      window.clearTimeout(usageAutoRefreshTimerRef.current);
      usageAutoRefreshTimerRef.current = null;
    }
  };

  const loadDashboard = useCallback(async () => {
    setDashboard((current) => ({
      ...current,
      apiEndpoint: buildApiEndpoint(),
      loading: true,
    }));

    const [healthResult, credentialResult, statsResult] = await Promise.all([
      requestJson<HealthResponse>('/health'),
      requestJson<CredentialsResponse>('/admin-api/credentials'),
      requestJson<StatsResponse>('/admin-api/stats'),
    ]);
    const items = credentialResult.data?.credentials ?? [];
    const validCredentials = items.filter((item) => !item.is_expired).length;
    const totalApiCalls = Object.values(
      statsResult.data?.model_usage ?? {},
    ).reduce((total, count) => total + count, 0);
    const credentialUsagePercent = items.length
      ? (validCredentials / items.length) * 100
      : 0;

    const checkedAt = `${consoleText.serviceCheckedAt} ${new Date(
      healthResult.data?.timestamp ?? new Date().toISOString(),
    ).toLocaleString(locale)}`;

    setDashboard({
      apiEndpoint: buildApiEndpoint(),
      credentialUsage: Object.entries(
        statsResult.data?.credential_usage ?? {},
      ).sort((left, right) => right[1] - left[1]),
      credentialUsagePercent,
      lastCheckedAt: checkedAt,
      loading: false,
      modelUsage: Object.entries(statsResult.data?.model_usage ?? {}).sort(
        (left, right) => right[1] - left[1],
      ),
      serviceStatus: healthResult.ok ? 'online' : 'offline',
      statusText: healthResult.ok
        ? consoleText.serviceRunning
        : consoleText.serviceUnavailable,
      totalApiCalls,
      totalCredentials: items.length,
      uptimeText: checkedAt,
      validCredentials,
    });
  }, [
    consoleText.serviceCheckedAt,
    consoleText.serviceRunning,
    consoleText.serviceUnavailable,
    locale,
    setDashboard,
  ]);

  const loadCredentials = useCallback(async () => {
    setCredentials((current) => ({
      ...current,
      accessKeysLoading: true,
      currentLoading: true,
      loading: true,
    }));

    const [listResult, currentResult, accessKeyResult] = await Promise.all([
      requestJson<CredentialsResponse>('/admin-api/credentials'),
      requestJson<CurrentCredentialResponse>('/admin-api/credentials/current'),
      requestJson<AccessKeysResponse>('/admin-api/access-keys'),
    ]);

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      accessKeys: accessKeyResult.data?.access_keys ?? [],
      accessKeysLoading: false,
      actionIndex: null,
      current: currentResult.data
        ? {
            available_credential_count:
              currentResult.data.available_credential_count,
            filename: currentResult.data.filename,
            index: currentResult.data.index,
            next_filename: currentResult.data.next_filename,
            status: currentResult.data.status ?? 'no_credentials',
            user_id: currentResult.data.user_id,
          }
        : {
            status: 'no_credentials',
          },
      currentLoading: false,
      items: listResult.data?.credentials ?? [],
      loading: false,
    }));

    setApiTest((current) => {
      const validCredentials = (listResult.data?.credentials ?? []).filter(
        (item) => !item.is_expired,
      );

      if (
        current.credentialFilename &&
        validCredentials.some(
          (credential) => credential.filename === current.credentialFilename,
        )
      ) {
        return current;
      }

      return {
        ...current,
        credentialFilename: validCredentials[0]?.filename ?? '',
      };
    });
  }, [setApiTest, setCredentials]);

  const refreshAccessKeys = useCallback(async () => {
    setCredentials((current) => ({ ...current, accessKeysLoading: true }));
    const result = await requestJson<AccessKeysResponse>(
      '/admin-api/access-keys',
    );

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      accessKeys: result.data?.access_keys ?? [],
      accessKeysLoading: false,
    }));
  }, [setCredentials]);

  const refreshCredentialList = useCallback(async () => {
    setCredentials((current) => ({
      ...current,
      currentLoading: true,
      loading: true,
    }));

    const [listResult, currentResult] = await Promise.all([
      requestJson<CredentialsResponse>('/admin-api/credentials'),
      requestJson<CurrentCredentialResponse>('/admin-api/credentials/current'),
    ]);

    setCredentials((current) => ({
      ...current,
      actionIndex: null,
      current: currentResult.data
        ? {
            available_credential_count:
              currentResult.data.available_credential_count,
            filename: currentResult.data.filename,
            index: currentResult.data.index,
            next_filename: currentResult.data.next_filename,
            status: currentResult.data.status ?? 'no_credentials',
            user_id: currentResult.data.user_id,
          }
        : { status: 'no_credentials' },
      currentLoading: false,
      items: listResult.data?.credentials ?? [],
      loading: false,
    }));

    setApiTest((current) => {
      const validCredentials = (listResult.data?.credentials ?? []).filter(
        (item) => !item.is_expired,
      );

      return current.credentialFilename &&
        validCredentials.some(
          (credential) => credential.filename === current.credentialFilename,
        )
        ? current
        : {
            ...current,
            credentialFilename: validCredentials[0]?.filename ?? '',
          };
    });
  }, [setApiTest, setCredentials]);

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({
      ...current,
      loading: true,
    }));

    const result = await requestJson<SettingsResponse>('/admin-api/settings');

    const nextValues = result.data?.settings ?? {};

    setSettings((current) => ({
      ...current,
      labels: result.data?.labels ?? {},
      loading: false,
      values: nextValues,
    }));

    setApiTest((current) => {
      if (current.model.trim()) {
        return current;
      }

      const configuredModels = getConfiguredModels(nextValues.CODEBUDDY_MODELS);

      return {
        ...current,
        model: configuredModels[0] ?? current.model,
        result: current.result || consoleText.requestIdle,
      };
    });
  }, [consoleText.requestIdle, setApiTest, setSettings]);

  const loadDebug = useCallback(
    async ({
      preserveSettings = false,
    }: { preserveSettings?: boolean } = {}) => {
      setDebug((current) => ({
        ...current,
        loading: true,
      }));

      const result = await requestJson<DebugResponse>('/admin-api/debug');

      if (!result.ok) {
        setDebug((current) => ({
          ...current,
          loading: false,
        }));
        showNotification(
          'error',
          getErrorMessage(result.data, consoleText.debugLoadFailed),
        );
        return;
      }

      setDebug((current) => ({
        autoRefreshSeconds: preserveSettings
          ? current.autoRefreshSeconds
          : typeof result.data?.autoRefreshSeconds === 'number'
            ? result.data.autoRefreshSeconds
            : 0,
        enabled: preserveSettings
          ? current.enabled
          : Boolean(result.data?.enabled),
        items: result.data?.items ?? [],
        loading: false,
        maxEntries: preserveSettings
          ? current.maxEntries
          : typeof result.data?.maxEntries === 'number'
            ? result.data.maxEntries
            : 100,
        saving: false,
      }));
    },
    [consoleText.debugLoadFailed, setDebug, showNotification],
  );

  const loadUsage = useCallback(
    async (requestOverride?: Partial<UsageFiltersState>) => {
      const nextRequest = {
        ...usageRequestRef.current,
        ...requestOverride,
      };
      usageRequestRef.current = nextRequest;

      setUsage((current) => ({
        ...current,
        loading: true,
        request: nextRequest,
      }));

      const params = new URLSearchParams({
        accessKey: nextRequest.accessKey,
        credential: nextRequest.credential,
        range: nextRequest.range,
      });
      const result = await requestJson<UsageResponse>(
        `/admin-api/usage?${params.toString()}`,
      );

      if (!result.ok) {
        setUsage((current) => ({
          ...current,
          loading: false,
          request: nextRequest,
        }));
        showNotification(
          'error',
          getErrorMessage(result.data, consoleText.usageLoadFailed),
        );
        return;
      }

      const resolvedRequest = {
        accessKey: nextRequest.accessKey,
        credential: nextRequest.credential,
        range: result.data?.range ?? nextRequest.range,
      };
      usageRequestRef.current = resolvedRequest;

      setUsage((current) => ({
        ...current,
        callSeries: result.data?.callSeries ?? [],
        filters: {
          accessKeys: result.data?.filters?.accessKeys ?? [],
          credentials: result.data?.filters?.credentials ?? [],
        },
        hoveredPoint: null,
        lastUpdatedAt: new Date().toLocaleTimeString(locale),
        loading: false,
        request: resolvedRequest,
        tableRows: (result.data?.tableRows ?? []).map((row) => ({
          callCount: row.callCount ?? 0,
          cacheHitTokens: row.cacheHitTokens ?? 0,
          model: row.model ?? 'unknown',
          totalTokens: row.totalTokens ?? 0,
        })),
        todaySummary: {
          cacheHitTokens: result.data?.todaySummary?.cacheHitTokens ?? 0,
          callCount: result.data?.todaySummary?.callCount ?? 0,
          totalTokens: result.data?.todaySummary?.totalTokens ?? 0,
        },
        tokenSeries: result.data?.tokenSeries ?? [],
      }));
    },
    [consoleText.usageLoadFailed, locale, setUsage, showNotification],
  );

  const refreshAdminData = useCallback(async () => {
    await Promise.all([loadDashboard(), loadCredentials()]);
  }, [loadCredentials, loadDashboard]);

  const clearUsageHistory = async () => {
    setUsage((current) => ({
      ...current,
      loading: true,
    }));

    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/usage/clear',
      {
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      setUsage((current) => ({
        ...current,
        loading: false,
      }));
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.usageClearFailed),
      );
      return;
    }

    showNotification('success', consoleText.usageCleared);
    await loadUsage();
  };

  const pollAuth = async (overrideState?: string) => {
    const authState = overrideState ?? auth.authState;

    if (!authState.trim()) {
      showNotification('warning', consoleText.authCheckMissing);
      return;
    }

    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      message: consoleText.authChecking,
      polling: true,
    }));

    const result = await requestJson<PollAuthResponse>('/codebuddy/auth/poll', {
      body: JSON.stringify({
        auth_state: authState,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (result.ok && result.data?.access_token) {
      setAuth((current) => ({
        ...current,
        completed: true,
        message: result.data?.message ?? consoleText.authSuccess,
        polling: false,
      }));
      showNotification('success', result.data.message ?? consoleText.authSaved);
      await refreshAdminData();
      return;
    }

    if (result.data?.error === 'authorization_pending') {
      setAuth((current) => ({
        ...current,
        message: consoleText.authPending,
        polling: false,
      }));
      authPollTimerRef.current = window.setTimeout(() => {
        void pollAuth(authState);
      }, auth.intervalSeconds * 1000);
      return;
    }

    const message = getErrorMessage(result.data, consoleText.authPollFailed);
    setAuth((current) => ({
      ...current,
      message,
      polling: false,
    }));
    showNotification('error', message);
  };

  const startAuth = async () => {
    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      authState: '',
      authUrl: '',
      callbackUrl: '',
      completed: false,
      message: '',
      polling: false,
      showManualCallback: false,
      starting: true,
    }));

    const result = await requestJson<StartAuthResponse>(
      '/codebuddy/auth/start',
    );

    if (
      !result.ok ||
      !result.data?.auth_state ||
      !result.data?.verification_uri_complete
    ) {
      const message = getErrorMessage(result.data, consoleText.authStartFailed);
      setAuth((current) => ({
        ...current,
        message,
        starting: false,
      }));
      showNotification('error', message);
      return;
    }

    setAuth((current) => ({
      ...current,
      authState: result.data?.auth_state ?? '',
      authUrl: result.data?.verification_uri_complete ?? '',
      completed: false,
      intervalSeconds: result.data?.interval ?? 5,
      message: consoleText.authStarted,
      starting: false,
    }));
    showNotification('success', consoleText.authCreated);
    authPollTimerRef.current = window.setTimeout(
      () => {
        void pollAuth(result.data?.auth_state);
      },
      (result.data?.interval ?? 5) * 1000,
    );
  };

  const addCredential = async () => {
    const isEditing = credentials.form.editingIndex !== null;

    if (!isEditing && !credentials.form.bearerToken.trim()) {
      showNotification('warning', consoleText.credentialRequired);
      return;
    }

    setCredentials((current) => ({
      ...current,
      actionIndex: -1,
    }));

    const result = await requestJson<{ filename?: string; success?: boolean }>(
      '/admin-api/credentials',
      {
        body: JSON.stringify(
          isEditing
            ? {
                index: credentials.form.editingIndex,
                first_message_role_to_system:
                  credentials.form.firstMessageRoleToSystem,
                responses_passthrough: credentials.form.responsesPassthrough,
              }
            : {
                access_token: credentials.form.bearerToken.trim(),
                bearer_token: credentials.form.bearerToken.trim(),
                first_message_role_to_system:
                  credentials.form.firstMessageRoleToSystem,
                responses_passthrough: credentials.form.responsesPassthrough,
                user_id: credentials.form.userId.trim() || undefined,
              },
        ),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.credentialSaveFailed),
      );
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      actionIndex: null,
      form: {
        bearerToken: '',
        editingIndex: null,
        firstMessageRoleToSystem: false,
        responsesPassthrough: false,
        userId: '',
      },
    }));
    showNotification(
      'success',
      consoleText.credentialSaved(result.data.filename ?? 'unknown'),
    );
    await refreshAdminData();
  };

  const deleteCredential = async (index: number) => {
    setCredentials((current) => ({
      ...current,
      actionIndex: index,
    }));

    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/credentials/delete',
      {
        body: JSON.stringify({ index }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.credentialDeleteFailed),
      );
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    showNotification('success', consoleText.credentialDeleted);
    await refreshAdminData();
  };

  const saveAccessKey = async () => {
    const { credentialFilenames, editingId, name } = credentials.accessKeyForm;

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: editingId ?? '__new__',
    }));

    const endpoint = editingId
      ? `/admin-api/access-keys/${editingId}`
      : '/admin-api/access-keys';
    const method = editingId ? 'PATCH' : 'POST';
    const result = await requestJson<{
      access_key?: AccessKeySummary;
      secret?: string;
    }>(endpoint, {
      body: JSON.stringify({
        credential_filenames: credentialFilenames,
        name,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method,
    });

    if (!result.ok) {
      showNotification(
        'error',
        getErrorMessage(
          result.data,
          editingId ? consoleText.apiKeyUpdated : consoleText.apiKeyCreated,
        ),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      accessKeyForm: {
        credentialFilenames: [],
        editingId: null,
        name: '',
      },
      revealedSecret:
        result.data?.access_key && result.data.secret
          ? {
              id: result.data.access_key.id,
              name: result.data.access_key.name,
              secret: result.data.secret,
            }
          : current.revealedSecret,
    }));
    showNotification(
      'success',
      editingId ? consoleText.apiKeyUpdated : consoleText.apiKeyCreated,
    );
    await loadCredentials();
  };

  const deleteAccessKey = async (id: string) => {
    setCredentials((current) => ({
      ...current,
      accessKeyActionId: id,
    }));

    const result = await requestJson<{ success?: boolean }>(
      `/admin-api/access-keys/${id}`,
      {
        method: 'DELETE',
      },
    );

    if (!result.ok || !result.data?.success) {
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.apiKeyDeleteFailed),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      revealedSecret:
        current.revealedSecret?.id === id ? null : current.revealedSecret,
    }));
    showNotification('success', consoleText.apiKeyDeleted);
    await loadCredentials();
  };

  const revealAccessKeySecret = async (id: string) => {
    setCredentials((current) => ({
      ...current,
      accessKeyActionId: id,
    }));

    const result = await requestJson<AccessKeySecretResponse>(
      `/admin-api/access-keys/${id}/secret`,
    );

    if (!result.ok || !result.data?.secret || !result.data?.name) {
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.apiKeyReadFailed),
      );
      setCredentials((current) => ({
        ...current,
        accessKeyActionId: null,
      }));
      return;
    }

    const secretPayload = result.data as {
      id?: string;
      name: string;
      secret: string;
    };

    setCredentials((current) => ({
      ...current,
      accessKeyActionId: null,
      revealedSecret: {
        id: secretPayload.id ?? id,
        name: secretPayload.name,
        secret: secretPayload.secret,
      },
    }));
    showNotification('success', consoleText.apiKeyDisplayed);
  };

  const copyText = async (value: string, successMessage: string) => {
    if (!value.trim()) {
      showNotification('warning', consoleText.clipboardEmpty);
      return;
    }

    if (!navigator.clipboard) {
      showNotification('warning', consoleText.clipboardUnsupported);
      return;
    }

    await navigator.clipboard.writeText(value);
    showNotification('success', successMessage);
  };

  const submitCallbackUrl = async () => {
    if (!auth.callbackUrl.trim()) {
      showNotification('warning', consoleText.authPending);
      return;
    }

    try {
      const url = new URL(auth.callbackUrl);
      const state = url.searchParams.get('state') ?? auth.authState;

      setAuth((current) => ({
        ...current,
        authState: state,
        showManualCallback: false,
      }));
      await pollAuth(state);
    } catch {
      showNotification('error', consoleText.authInvalidCallback);
    }
  };

  const testApi = async () => {
    setApiTest((current) => ({
      ...current,
      result: consoleText.requestSending,
      submitting: true,
    }));

    const response = await fetch('/admin-api/chat/completions', {
      body: JSON.stringify({
        credential_filename: apiTest.credentialFilename || undefined,
        messages: [
          {
            content: apiTest.message,
            role: 'user',
          },
        ],
        model:
          apiTest.model ||
          getConfiguredModels(settings.values.CODEBUDDY_MODELS)[0] ||
          DEFAULT_TEST_MODELS[0],
        stream: apiTest.stream,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    if (!response.ok) {
      const text = await response.text();

      try {
        const payload = JSON.parse(text) as Record<string, unknown>;

        setApiTest((current) => ({
          ...current,
          result: formatResult(payload),
          submitting: false,
        }));
        showNotification(
          'error',
          getErrorMessage(payload, consoleText.requestFailed),
        );
        return;
      } catch {
        setApiTest((current) => ({
          ...current,
          result: text || consoleText.requestFailed,
          submitting: false,
        }));
        showNotification('error', consoleText.requestFailed);
        return;
      }
    }

    if (apiTest.stream && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let streamedResult = '';
      let done = false;

      while (!done) {
        const next = await reader.read();
        done = next.done;
        buffered += decoder.decode(next.value, { stream: !done });
        const events = buffered.split(/\r?\n\r?\n/);
        buffered = events.pop() ?? '';
        const nextContent = events.map(getSseEventContent).join('');

        if (nextContent) {
          streamedResult += nextContent;
          setApiTest((current) => ({
            ...current,
            result: streamedResult,
          }));
        }
      }

      const finalContent = getSseEventContent(buffered);

      if (finalContent) {
        streamedResult += finalContent;
      }

      setApiTest((current) => ({
        ...current,
        result: streamedResult || consoleText.requestIdle,
        submitting: false,
      }));
      return;
    }

    const text = await response.text();

    try {
      const payload = JSON.parse(text) as ApiTestSuccess;
      const content = payload.choices?.[0]?.message?.content;

      setApiTest((current) => ({
        ...current,
        result:
          content !== undefined ? formatResult(content) : formatResult(payload),
        submitting: false,
      }));
    } catch {
      setApiTest((current) => ({
        ...current,
        result: text,
        submitting: false,
      }));
    }
  };

  const saveSettings = async () => {
    setSettings((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<{
      message?: string;
      settings?: Record<string, string | number | null>;
    }>('/admin-api/settings', {
      body: JSON.stringify({
        settings: settings.values,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!result.ok) {
      setSettings((current) => ({
        ...current,
        saving: false,
      }));
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.settingsSaveFailed),
      );
      return;
    }

    setSettings((current) => ({
      ...current,
      saving: false,
      values: result.data?.settings ?? current.values,
    }));
    setApiTest((current) => {
      const configuredModels = getConfiguredModels(
        result.data?.settings?.CODEBUDDY_MODELS,
      );
      const nextModel = configuredModels[0] ?? current.model;

      if (
        current.model.trim() &&
        configuredModels.includes(current.model.trim())
      ) {
        return current;
      }

      return {
        ...current,
        model: nextModel,
      };
    });
    showNotification(
      'success',
      result.data?.message ?? consoleText.settingsSaved,
    );
  };

  const saveDebugSettings = async () => {
    setDebug((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<DebugResponse>('/admin-api/debug', {
      body: JSON.stringify({
        autoRefreshSeconds: debug.autoRefreshSeconds,
        enabled: debug.enabled,
        maxEntries: debug.maxEntries,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (!result.ok) {
      setDebug((current) => ({
        ...current,
        saving: false,
      }));
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.debugSaveFailed),
      );
      return;
    }

    setDebug({
      autoRefreshSeconds:
        typeof result.data?.autoRefreshSeconds === 'number'
          ? result.data.autoRefreshSeconds
          : debug.autoRefreshSeconds,
      enabled: Boolean(result.data?.enabled),
      items: result.data?.items ?? [],
      loading: false,
      maxEntries:
        typeof result.data?.maxEntries === 'number'
          ? result.data.maxEntries
          : debug.maxEntries,
      saving: false,
    });
    showNotification('success', result.data?.message ?? consoleText.debugSaved);
  };

  const clearDebugItems = async () => {
    setDebug((current) => ({
      ...current,
      saving: true,
    }));

    const result = await requestJson<DebugResponse>('/admin-api/debug', {
      method: 'DELETE',
    });

    if (!result.ok) {
      setDebug((current) => ({
        ...current,
        saving: false,
      }));
      showNotification(
        'error',
        getErrorMessage(result.data, consoleText.debugClearFailed),
      );
      return;
    }

    setDebug((current) => ({
      ...current,
      items: [],
      saving: false,
    }));
    showNotification(
      'success',
      result.data?.message ?? consoleText.debugCleared,
    );
  };

  useEffect(() => {
    if (!initialData) {
      void Promise.all([
        loadDashboard(),
        loadCredentials(),
        loadDebug(),
        loadUsage(),
        loadSettings(),
      ]);
    }

    return () => {
      clearAuthTimer();
      clearDebugAutoRefreshTimer();
      clearUsageTimer();
    };
  }, [
    activeTab,
    clearDebugAutoRefreshTimer,
    initialData,
    loadCredentials,
    loadDashboard,
    loadDebug,
    loadSettings,
    loadUsage,
  ]);

  useEffect(() => {
    void fetch('/admin-api/auth/session')
      .then(async (response) => {
        const payload = (await response.json()) as {
          session?: { authenticated: boolean };
        };
        setAdminSession(payload.session ?? null);
      })
      .catch(() => {
        setAdminSession(null);
      });
  }, [setAdminSession]);

  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        theme === 'dark' ||
        (theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);

      document.documentElement.classList.toggle('dark', isDark);
      document.body.classList.toggle('dark', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      window.dispatchEvent(
        new CustomEvent(themeChangeEventName, {
          detail: isDark ? 'dark' : 'light',
        }),
      );
      document.cookie = `${resolvedThemeCookieName}=${isDark ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Lax`;
    };

    applyTheme();
    document.cookie = `${themeCookieName}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;

    if (theme !== 'system') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', applyTheme);

    return () => {
      mediaQuery.removeEventListener('change', applyTheme);
    };
  }, [theme]);

  const changeLocale = (nextLocale: string) => {
    document.cookie = `${localePreferenceCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.cookie =
      nextLocale === systemLocalePreference
        ? `${localeCookieName}=; Path=/; Max-Age=0; SameSite=Lax`
        : `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  };

  const logout = async () => {
    const response = await fetch('/admin-api/auth/session', {
      method: 'DELETE',
    });

    if (response.ok) {
      window.location.assign('/login');
      return;
    }

    showNotification('error', translations('logoutUnavailable'));
  };

  useEffect(() => {
    clearDebugAutoRefreshTimer();

    if (!debug.enabled || debug.autoRefreshSeconds <= 0) {
      return;
    }

    debugAutoRefreshTimerRef.current = window.setInterval(() => {
      void loadDebug({ preserveSettings: true });
    }, debug.autoRefreshSeconds * 1000);

    return () => {
      clearDebugAutoRefreshTimer();
    };
  }, [
    clearDebugAutoRefreshTimer,
    debug.autoRefreshSeconds,
    debug.enabled,
    loadDebug,
  ]);

  useEffect(() => {
    clearUsageTimer();

    if (usage.autoRefreshSeconds <= 0 || activeTab !== 'usage') {
      return;
    }

    usageAutoRefreshTimerRef.current = window.setTimeout(() => {
      void loadUsage();
    }, usage.autoRefreshSeconds * 1000);

    return () => {
      clearUsageTimer();
    };
  }, [activeTab, loadUsage, usage.autoRefreshSeconds, usage.request]);

  return (
    <>
      <div id="dashboardPage" className="console-workspace">
        <AdminHeader
          action={
            adminSession?.authenticated ? (
              <Button
                className="console-logout"
                htmlType="button"
                icon={LogOut}
                onClick={() => void logout()}
              >
                {translations('logoutLabel')}
              </Button>
            ) : null
          }
          brand={translations('brand')}
          className="console-header"
          locale={locale}
          localePreference={initialLocalePreference}
          onLocaleChange={changeLocale}
          onThemeChange={setTheme}
          theme={theme}
          themeLabels={{
            dark: translations('themeDark'),
            light: translations('themeLight'),
            system: translations('themeSystem'),
          }}
          systemLocaleLabel={translations('languageSystem')}
        />
        <main className="console-main">
          <TabNav
            activeTab={activeTab}
            onChange={(nextTab) => {
              router.push(adminTabPaths[nextTab] as Route);
            }}
          />
          {activeTab === 'dashboard' ? (
            <DashboardSection
              onCopyEndpoint={() => {
                void copyText(dashboard.apiEndpoint, 'API 端点已复制。');
              }}
              onRefresh={() => {
                void loadDashboard();
              }}
              state={dashboard}
            />
          ) : null}
          {activeTab === 'credentials' ? (
            <CredentialsSection
              auth={auth}
              credentials={credentials}
              onAddCredential={() => {
                void addCredential();
              }}
              onAuthAction={() => {
                void startAuth();
              }}
              onCallbackUrlChange={(value) => {
                setAuth((current) => ({
                  ...current,
                  callbackUrl: value,
                }));
              }}
              onCopyAuthUrl={() => {
                void copyText(auth.authUrl, '认证链接已复制。');
              }}
              onCredentialFirstMessageRoleToSystemChange={(value) => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    ...current.form,
                    firstMessageRoleToSystem: value,
                  },
                }));
              }}
              onCredentialResponsesPassthroughChange={(value) => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    ...current.form,
                    responsesPassthrough: value,
                  },
                }));
              }}
              onCredentialTokenChange={(value) => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    ...current.form,
                    bearerToken: value,
                  },
                }));
              }}
              onCredentialUserIdChange={(value) => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    ...current.form,
                    userId: value,
                  },
                }));
              }}
              onDeleteCredential={(index) => {
                void deleteCredential(index);
              }}
              onEditCredential={(credential) => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    bearerToken: '',
                    editingIndex: credential.index,
                    firstMessageRoleToSystem:
                      credential.first_message_role_to_system,
                    responsesPassthrough: credential.responses_passthrough,
                    userId: credential.user_id ?? '',
                  },
                }));
              }}
              onDeleteAccessKey={(id) => {
                void deleteAccessKey(id);
              }}
              onEditAccessKey={(accessKey) => {
                setCredentials((current) => ({
                  ...current,
                  accessKeyForm: {
                    credentialFilenames: accessKey.credentialFilenames.filter(
                      (filename) =>
                        current.items.some(
                          (credential) =>
                            !credential.is_expired &&
                            credential.filename === filename,
                        ),
                    ),
                    editingId: accessKey.id,
                    name: accessKey.name,
                  },
                }));
              }}
              onOpenAuthUrl={() => {
                if (!auth.authUrl) {
                  showNotification('warning', consoleText.authLinkMissing);
                  return;
                }

                window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
              }}
              onPollAuth={() => {
                void pollAuth();
              }}
              onRefreshAccessKeys={() => {
                void refreshAccessKeys();
              }}
              onRefreshCredentialList={() => {
                void refreshCredentialList();
              }}
              onResetCredentialForm={() => {
                setCredentials((current) => ({
                  ...current,
                  form: {
                    bearerToken: '',
                    editingIndex: null,
                    firstMessageRoleToSystem: false,
                    responsesPassthrough: false,
                    userId: '',
                  },
                }));
              }}
              onRevealAccessKeySecret={(id) => {
                void revealAccessKeySecret(id);
              }}
              onSaveAccessKey={() => {
                void saveAccessKey();
              }}
              onSubmitCallbackUrl={() => {
                void submitCallbackUrl();
              }}
              onToggleCallbackMode={(showManual) => {
                setAuth((current) => ({
                  ...current,
                  showManualCallback: showManual,
                }));
              }}
              onToggleCredentialSelection={(filename) => {
                setCredentials((current) => {
                  const selected =
                    current.accessKeyForm.credentialFilenames.includes(
                      filename,
                    );

                  return {
                    ...current,
                    accessKeyForm: {
                      ...current.accessKeyForm,
                      credentialFilenames: selected
                        ? current.accessKeyForm.credentialFilenames.filter(
                            (item) => item !== filename,
                          )
                        : [
                            ...current.accessKeyForm.credentialFilenames,
                            filename,
                          ],
                    },
                  };
                });
              }}
              onUpdateAccessKeyName={(value) => {
                setCredentials((current) => ({
                  ...current,
                  accessKeyForm: {
                    ...current.accessKeyForm,
                    name: value,
                  },
                }));
              }}
              onResetAccessKeyForm={() => {
                setCredentials((current) => ({
                  ...current,
                  accessKeyForm: {
                    credentialFilenames: [],
                    editingId: null,
                    name: '',
                  },
                }));
              }}
            />
          ) : null}
          {activeTab === 'usage' ? (
            <UsageSection
              onAccessKeyChange={(value) => {
                void loadUsage({
                  accessKey: value,
                });
              }}
              onClearHistory={() => {
                void clearUsageHistory();
              }}
              onCredentialChange={(value) => {
                void loadUsage({
                  credential: value,
                });
              }}
              onHoverPoint={(point) => {
                setUsage((current) => ({
                  ...current,
                  hoveredPoint: point,
                }));
              }}
              onRangeChange={(value) => {
                void loadUsage({
                  range: value,
                });
              }}
              onRefresh={() => {
                void loadUsage();
              }}
              onAutoRefreshSecondsChange={(value) => {
                setUsage((current) => ({
                  ...current,
                  autoRefreshSeconds: value,
                  autoRefreshVisible: true,
                }));
              }}
              state={usage}
            />
          ) : null}
          {activeTab === 'api-test' ? (
            <ApiTestSection
              credentialOptions={credentials.items.filter(
                (item) => !item.is_expired,
              )}
              onCredentialChange={(value) => {
                setApiTest((current) => ({
                  ...current,
                  credentialFilename: value,
                }));
              }}
              models={String(settings.values.CODEBUDDY_MODELS ?? '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)}
              onMessageChange={(value) => {
                setApiTest((current) => ({
                  ...current,
                  message: value,
                }));
              }}
              onModelChange={(value) => {
                setApiTest((current) => ({
                  ...current,
                  model: value,
                }));
              }}
              onStreamChange={(checked) => {
                setApiTest((current) => ({
                  ...current,
                  stream: checked,
                }));
              }}
              onSubmit={() => {
                void testApi();
              }}
              state={apiTest}
            />
          ) : null}
          {activeTab === 'debug' ? (
            <DebugSection
              autoRefreshOptions={[...debugAutoRefreshOptions]}
              onClear={() => {
                void clearDebugItems();
              }}
              onCopy={(value) => {
                void copyText(value, consoleText.copyContent);
              }}
              onAutoRefreshSecondsChange={(value) => {
                setDebug((current) => ({
                  ...current,
                  autoRefreshSeconds: value,
                }));
              }}
              onEnabledChange={(value) => {
                setDebug((current) => ({
                  ...current,
                  enabled: value,
                }));
              }}
              onMaxEntriesChange={(value) => {
                setDebug((current) => ({
                  ...current,
                  maxEntries: value,
                }));
              }}
              onRefresh={() => {
                void loadDebug({ preserveSettings: true });
              }}
              onSave={() => {
                void saveDebugSettings();
              }}
              state={debug}
            />
          ) : null}
          {activeTab === 'settings' ? (
            <SettingsSection
              onChange={(key, value) => {
                setSettings((current) => ({
                  ...current,
                  values: {
                    ...current.values,
                    [key]: value,
                  },
                }));
              }}
              onSave={() => {
                void saveSettings();
              }}
              state={settings}
            />
          ) : null}
        </main>
      </div>
      <ToastHost duration={3000} position="top-right" />
    </>
  );
};

const AdminConsole = (props: AdminConsoleProps) => {
  const store = useMemo(() => createStore(), []);

  return (
    <Provider store={store}>
      <AdminConsoleContent {...props} />
    </Provider>
  );
};

export default AdminConsole;
