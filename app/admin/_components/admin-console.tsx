'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';

import {
  createCredentialsState,
  createDashboardState,
  createSettingsState,
  type AdminConsoleInitialData,
} from '@/app/admin/_components/admin-initial-state';
import {
  ApiTestSection,
  CredentialsSection,
  DashboardSection,
  NotificationBar,
  SettingsSection,
  TabNav,
} from '@/app/admin/_components/admin-sections';
import {
  activeTabAtom,
  apiTestStateAtom,
  authStateAtom,
  type CredentialSummary,
  credentialsStateAtom,
  dashboardStateAtom,
  defaultCredentialsState,
  defaultDashboardState,
  defaultSettingsState,
  notificationAtom,
  settingsStateAtom,
  themeAtom,
} from '@/app/admin/_components/admin-store';

interface HealthResponse {
  status?: string;
  timestamp?: string;
}

interface CredentialsResponse {
  credentials?: CredentialSummary[];
}

interface CurrentCredentialResponse {
  auto_rotation_enabled?: boolean;
  filename?: string;
  index?: number;
  rotation_count?: number;
  status?: string;
  user_id?: string;
}

interface StatsResponse {
  credential_usage?: Record<string, number>;
  model_usage?: Record<string, number>;
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
  const initialSettingsState = initialData
    ? createSettingsState(initialData)
    : defaultSettingsState;

  useHydrateAtoms([
    [dashboardStateAtom, initialDashboardState],
    [credentialsStateAtom, initialCredentialsState],
    [settingsStateAtom, initialSettingsState],
  ]);

  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  const [notification, setNotification] = useAtom(notificationAtom);
  const [dashboard, setDashboard] = useAtom(dashboardStateAtom);
  const [credentials, setCredentials] = useAtom(credentialsStateAtom);
  const [auth, setAuth] = useAtom(authStateAtom);
  const [apiTest, setApiTest] = useAtom(apiTestStateAtom);
  const [settings, setSettings] = useAtom(settingsStateAtom);
  const authPollTimerRef = useRef<number | null>(null);

  const showNotification = (
    type: 'success' | 'error' | 'warning' | 'info',
    message: string,
  ) => {
    setNotification({
      message,
      type,
    });
  };

  const clearAuthTimer = () => {
    if (authPollTimerRef.current !== null) {
      window.clearTimeout(authPollTimerRef.current);
      authPollTimerRef.current = null;
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
            auto_rotation_enabled: currentResult.data.auto_rotation_enabled,
            filename: currentResult.data.filename,
            index: currentResult.data.index,
            rotation_count: currentResult.data.rotation_count,
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
  }, [setCredentials]);

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({
      ...current,
      loading: true,
    }));

    const result = await requestJson<SettingsResponse>('/admin-api/settings');

    setSettings((current) => ({
      ...current,
      labels: result.data?.labels ?? {},
      loading: false,
      values: result.data?.settings ?? {},
    }));
  }, [setSettings]);

  const refreshAdminData = useCallback(async () => {
    await Promise.all([loadDashboard(), loadCredentials()]);
  }, [loadCredentials, loadDashboard]);

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
    if (!credentials.form.bearerToken.trim()) {
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
        body: JSON.stringify({
          access_token: credentials.form.bearerToken.trim(),
          bearer_token: credentials.form.bearerToken.trim(),
          user_id: credentials.form.userId.trim() || undefined,
        }),
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
        userId: '',
      },
    }));
    showNotification(
      'success',
      `凭证已保存：${result.data.filename ?? 'unknown'}`,
    );
    await refreshAdminData();
  };

  const selectCredential = async (index: number) => {
    setCredentials((current) => ({
      ...current,
      actionIndex: index,
    }));

    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/credentials/select',
      {
        body: JSON.stringify({ index }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showNotification('error', getErrorMessage(result.data, '切换凭证失败。'));
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    showNotification('success', '当前凭证已切换。');
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

  const toggleRotation = async () => {
    const result = await requestJson<{ auto_rotation_enabled?: boolean }>(
      '/admin-api/credentials/toggle-rotation',
      {
        method: 'POST',
      },
    );

    if (!result.ok) {
      showNotification(
        'error',
        getErrorMessage(result.data, '更新轮换状态失败。'),
      );
      return;
    }

    showNotification(
      'success',
      result.data?.auto_rotation_enabled
        ? '自动轮换已开启。'
        : '自动轮换已暂停。',
    );
    await loadCredentials();
  };

  const resumeAutoRotation = async () => {
    const result = await requestJson<{ success?: boolean }>(
      '/admin-api/credentials/auto',
      {
        method: 'POST',
      },
    );

    if (!result.ok || !result.data?.success) {
      showNotification(
        'error',
        getErrorMessage(result.data, '恢复自动轮换失败。'),
      );
      return;
    }

    showNotification('success', '自动轮换已恢复。');
    await loadCredentials();
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
    showNotification('success', result.data?.message ?? '设置已保存。');
  };

  useEffect(() => {
    if (!initialData) {
      void Promise.all([loadDashboard(), loadCredentials(), loadSettings()]);
    }

    return () => {
      clearAuthTimer();
    };
  }, [initialData, loadCredentials, loadDashboard, loadSettings]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(
      'codebuddy2api-admin-theme',
    );
    const storedTab = window.localStorage.getItem('codebuddy2api-admin-tab');

    if (storedTheme === 'dark' || storedTheme === 'light') {
      setTheme(storedTheme);
    }

    if (
      storedTab === 'dashboard' ||
      storedTab === 'credentials' ||
      storedTab === 'api-test' ||
      storedTab === 'settings'
    ) {
      setActiveTab(storedTab);
    }
  }, [setActiveTab, setTheme]);

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('codebuddy2api-admin-theme', theme);
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

  return (
    <>
      <div id="dashboardPage">
        <header className="fixed top-0 left-0 right-0 z-100 flex justify-between items-center px-8 py-4 bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark border-b border-border-light dark:border-border-dark">
          <h1 className="text-xl font-semibold font-serif">
            <i className="fas fa-robot"></i>
            CodeBuddy2API 管理面板
          </h1>
          <div className="flex items-center gap-4">
            <button
              className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark text-text-light dark:text-text-dark px-4 py-2 cursor-pointer transition-all hover:bg-bg-light hover:border-primary hover:text-primary dark:hover:bg-bg-dark"
              onClick={() => {
                setTheme(theme === 'dark' ? 'light' : 'dark');
              }}
            >
              <i
                className={theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon'}
                id="themeIcon"
              ></i>
            </button>
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
              onResumeAutoRotation={() => {
                void resumeAutoRotation();
              }}
              onSelectCredential={(index) => {
                void selectCredential(index);
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
              onToggleRotation={() => {
                void toggleRotation();
              }}
            />
          ) : null}
          {activeTab === 'api-test' ? (
            <ApiTestSection
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
          {activeTab === 'settings' ? (
            <SettingsSection
              onChange={(key, value) => {
                setSettings((current) => ({
                  ...current,
                  values: {
                    ...current.values,
                    [key]:
                      key === 'CODEBUDDY_ROTATION_COUNT'
                        ? Number(value)
                        : value,
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
