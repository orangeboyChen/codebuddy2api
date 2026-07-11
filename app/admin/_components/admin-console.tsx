'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';

import {
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
  NotificationBar,
  SettingsSection,
  TabNav,
  UsageSection,
} from '@/app/admin/_components/admin-sections';
import {
  activeTabAtom,
  apiTestStateAtom,
  authStateAtom,
  type AccessKeySummary,
  type CredentialSummary,
  credentialsStateAtom,
  debugStateAtom,
  dashboardStateAtom,
  defaultCredentialsState,
  defaultDebugState,
  defaultDashboardState,
  defaultSettingsState,
  defaultUsageState,
  notificationAtom,
  settingsStateAtom,
  themeAtom,
  type ThemeMode,
  type UsageChartSeries,
  type UsageFilterOption,
  type UsageFiltersState,
  type UsageRange,
  usageStateAtom,
} from '@/app/admin/_components/admin-store';

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

const DEBUG_AUTO_REFRESH_OPTIONS = [
  { label: '自动刷新：关闭', value: 0 },
  { label: '自动刷新：5 秒', value: 5 },
  { label: '自动刷新：10 秒', value: 10 },
  { label: '自动刷新：15 秒', value: 15 },
  { label: '自动刷新：30 秒', value: 30 },
  { label: '自动刷新：1 分钟', value: 60 },
  { label: '自动刷新：2 分钟', value: 120 },
  { label: '自动刷新：5 分钟', value: 300 },
] as const;

interface ApiTestSuccess {
  choices?: Array<{
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

const resolveSystemDark = () => {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const resolveDarkMode = (theme: ThemeMode) => {
  if (theme === 'system') {
    return resolveSystemDark();
  }

  return theme === 'dark';
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

interface AdminConsoleProps {
  initialData?: AdminConsoleInitialData;
}

const AdminConsole = ({ initialData }: AdminConsoleProps) => {
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

  useHydrateAtoms([
    [dashboardStateAtom, initialDashboardState],
    [credentialsStateAtom, initialCredentialsState],
    [debugStateAtom, initialDebugState],
    [usageStateAtom, initialUsageState],
    [settingsStateAtom, initialSettingsState],
  ]);

  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  const [notification, setNotification] = useAtom(notificationAtom);
  const [dashboard, setDashboard] = useAtom(dashboardStateAtom);
  const [credentials, setCredentials] = useAtom(credentialsStateAtom);
  const [debug, setDebug] = useAtom(debugStateAtom);
  const [usage, setUsage] = useAtom(usageStateAtom);
  const [auth, setAuth] = useAtom(authStateAtom);
  const [apiTest, setApiTest] = useAtom(apiTestStateAtom);
  const [settings, setSettings] = useAtom(settingsStateAtom);
  const authPollTimerRef = useRef<number | null>(null);
  const debugAutoRefreshTimerRef = useRef<number | null>(null);
  const usageAutoRefreshTimerRef = useRef<number | null>(null);
  const usageRequestRef = useRef(usage.request);

  const showNotification = useCallback(
    (type: 'success' | 'error' | 'warning' | 'info', message: string) => {
      setNotification({
        message,
        type,
      });
    },
    [setNotification],
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

    setDashboard({
      apiEndpoint: buildApiEndpoint(),
      credentialUsage: Object.entries(
        statsResult.data?.credential_usage ?? {},
      ).sort((left, right) => right[1] - left[1]),
      credentialUsagePercent,
      lastCheckedAt: new Date().toLocaleTimeString('zh-CN'),
      loading: false,
      modelUsage: Object.entries(statsResult.data?.model_usage ?? {}).sort(
        (left, right) => right[1] - left[1],
      ),
      serviceStatus: healthResult.ok ? 'online' : 'offline',
      statusText: healthResult.ok ? '运行中' : '不可用',
      totalApiCalls,
      totalCredentials: items.length,
      uptimeText: healthResult.data?.timestamp
        ? `最后检查 ${new Date(healthResult.data.timestamp).toLocaleString('zh-CN')}`
        : '状态已刷新',
      validCredentials,
    });
  }, [setDashboard]);

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
      };
    });
  }, [setApiTest, setSettings]);

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
          getErrorMessage(result.data, '加载 Debug 记录失败。'),
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
    [setDebug, showNotification],
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
          getErrorMessage(result.data, '加载用量统计数据失败。'),
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
        lastUpdatedAt: new Date().toLocaleTimeString('zh-CN'),
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
    [setUsage, showNotification],
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
        getErrorMessage(result.data, '清空用量统计历史失败。'),
      );
      return;
    }

    showNotification('success', '用量统计历史已清空。');
    await loadUsage();
  };

  const pollAuth = async (overrideState?: string) => {
    const authState = overrideState ?? auth.authState;

    if (!authState.trim()) {
      showNotification('warning', '缺少认证状态，无法继续轮询。');
      return;
    }

    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      message: '正在检查认证状态...',
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
        message: result.data?.message ?? '认证成功！',
        polling: false,
      }));
      showNotification(
        'success',
        result.data.message ?? '认证成功，凭证已保存。',
      );
      await refreshAdminData();
      return;
    }

    if (result.data?.error === 'authorization_pending') {
      setAuth((current) => ({
        ...current,
        message: result.data?.error_description ?? '等待认证完成...',
        polling: false,
      }));
      authPollTimerRef.current = window.setTimeout(() => {
        void pollAuth(authState);
      }, auth.intervalSeconds * 1000);
      return;
    }

    const message = getErrorMessage(result.data, '认证轮询失败。');
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
      const message = getErrorMessage(result.data, '启动认证失败。');
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
      message: result.data?.message ?? '请完成登录，系统会自动轮询结果。',
      starting: false,
    }));
    showNotification('success', '认证链接已生成。');
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
      showNotification('warning', 'Bearer Token 不能为空。');
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
      showNotification('error', getErrorMessage(result.data, '添加凭证失败。'));
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
      `凭证已保存：${result.data.filename ?? 'unknown'}`,
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
      showNotification('error', getErrorMessage(result.data, '删除凭证失败。'));
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    showNotification('success', '凭证已删除。');
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
          editingId ? '更新 API Key 失败。' : '创建 API Key 失败。',
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
      accessKeyCreating: false,
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
      editingId ? 'API Key 已更新。' : 'API Key 已生成。',
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
        getErrorMessage(result.data, '删除 API Key 失败。'),
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
    showNotification('success', 'API Key 已删除。');
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
        getErrorMessage(result.data, '读取 API Key 失败。'),
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
    showNotification('success', 'API Key 已显示。');
  };

  const copyText = async (value: string, successMessage: string) => {
    if (!value.trim()) {
      showNotification('warning', '没有可复制的内容。');
      return;
    }

    if (!navigator.clipboard) {
      showNotification('warning', '当前环境不支持剪贴板。');
      return;
    }

    await navigator.clipboard.writeText(value);
    showNotification('success', successMessage);
  };

  const submitCallbackUrl = async () => {
    if (!auth.callbackUrl.trim()) {
      showNotification('warning', '请先粘贴回调链接。');
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
      showNotification('error', '回调链接格式不正确。');
    }
  };

  const testApi = async () => {
    setApiTest((current) => ({
      ...current,
      result: '请求发送中...',
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
        model: apiTest.model,
        stream: apiTest.stream,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    const text = await response.text();

    if (!response.ok) {
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;

        setApiTest((current) => ({
          ...current,
          result: formatResult(payload),
          submitting: false,
        }));
        showNotification('error', getErrorMessage(payload, 'API 测试失败。'));
        return;
      } catch {
        setApiTest((current) => ({
          ...current,
          result: text || 'API 测试失败。',
          submitting: false,
        }));
        showNotification('error', 'API 测试失败。');
        return;
      }
    }

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
      showNotification('error', getErrorMessage(result.data, '保存设置失败。'));
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
    showNotification('success', result.data?.message ?? '设置已保存。');
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
        getErrorMessage(result.data, '保存 Debug 设置失败。'),
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
    showNotification('success', result.data?.message ?? 'Debug 设置已保存。');
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
        getErrorMessage(result.data, '清空 Debug 记录失败。'),
      );
      return;
    }

    setDebug((current) => ({
      ...current,
      items: [],
      saving: false,
    }));
    showNotification('success', result.data?.message ?? 'Debug 记录已清空。');
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
    } else if (!initialData.usage) {
      void loadUsage();
    }

    return () => {
      clearAuthTimer();
      clearDebugAutoRefreshTimer();
      clearUsageTimer();
    };
  }, [
    clearDebugAutoRefreshTimer,
    initialData,
    loadCredentials,
    loadDashboard,
    loadDebug,
    loadSettings,
    loadUsage,
  ]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(
      'codebuddy2api-admin-theme',
    );
    const storedTab = window.localStorage.getItem('codebuddy2api-admin-tab');

    if (
      storedTheme === 'dark' ||
      storedTheme === 'light' ||
      storedTheme === 'system'
    ) {
      setTheme(storedTheme);
    }

    if (
      storedTab === 'dashboard' ||
      storedTab === 'usage' ||
      storedTab === 'credentials' ||
      storedTab === 'api-test' ||
      storedTab === 'debug' ||
      storedTab === 'settings'
    ) {
      setActiveTab(storedTab);
    }
  }, [setActiveTab, setTheme]);

  useEffect(() => {
    const applyTheme = () => {
      const isDark = resolveDarkMode(theme);

      document.documentElement.classList.toggle('dark', isDark);
      document.body.classList.toggle('dark', isDark);
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    };

    applyTheme();
    window.localStorage.setItem('codebuddy2api-admin-theme', theme);

    if (theme !== 'system' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      applyTheme();
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('codebuddy2api-admin-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!notification) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setNotification(null);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [notification, setNotification]);

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
      <div id="dashboardPage">
        <header className="fixed top-0 left-0 right-0 z-100 flex justify-between items-center px-8 py-4 bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark border-b border-border-light dark:border-border-dark">
          <h1 className="text-xl font-semibold font-serif">
            <i className="fas fa-robot"></i>
            CodeBuddy2API 管理面板
          </h1>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-secondary">
              <i
                className={
                  theme === 'dark'
                    ? 'fas fa-moon'
                    : theme === 'light'
                      ? 'fas fa-sun'
                      : 'fas fa-desktop'
                }
              ></i>
              <select
                aria-label="Theme mode"
                className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark px-3 py-2 cursor-pointer transition-all hover:border-primary focus:outline-none focus:border-primary focus:ring-3 focus:ring-primary/10"
                value={theme}
                onChange={(event) => {
                  setTheme(event.target.value as ThemeMode);
                }}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色模式</option>
                <option value="dark">暗黑模式</option>
              </select>
            </label>
          </div>
        </header>
        <main className="mt-20 px-8 py-8 max-w-[1400px] mx-auto">
          <TabNav activeTab={activeTab} onChange={setActiveTab} />
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
              onAddAccessKey={() => {
                setCredentials((current) => ({
                  ...current,
                  accessKeyCreating: true,
                  accessKeyForm: {
                    credentialFilenames: [],
                    editingId: null,
                    name: '',
                  },
                  revealedSecret: null,
                }));
              }}
              onEditAccessKey={(accessKey) => {
                setCredentials((current) => ({
                  ...current,
                  accessKeyCreating: false,
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
                  showNotification('warning', '认证链接还未生成。');
                  return;
                }

                window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
              }}
              onPollAuth={() => {
                void pollAuth();
              }}
              onRefreshCredentials={() => {
                void refreshAdminData();
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
                  accessKeyCreating: false,
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
              autoRefreshOptions={[...DEBUG_AUTO_REFRESH_OPTIONS]}
              onClear={() => {
                void clearDebugItems();
              }}
              onCopy={(value) => {
                void copyText(value, '内容已复制。');
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
      <NotificationBar notification={notification} />
    </>
  );
};

export default AdminConsole;
