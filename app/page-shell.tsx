'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { createStore, Provider, useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Button, ToastHost, toast } from '@lobehub/ui/base-ui';
import { Tabs } from '@lobehub/ui/base-ui';
import {
  Bug,
  ChartLine,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Send,
  Settings2,
} from 'lucide-react';

import type { AdminConsoleInitialData } from '@/app/page-data';
import {
  createDashboardState,
  dashboardStateAtom,
  DashboardProvider,
  defaultDashboardState,
} from '@/app/dashboard/dashboard';
import {
  createDebugState,
  debugStateAtom,
  defaultDebugState,
  DebugProvider,
  type DebugLogEntry,
} from '@/app/debug/debug';
import {
  createSettingsState,
  defaultSettingsState,
  SettingsProvider,
  settingsStateAtom,
} from '@/app/settings/settings';
import {
  createUsageState,
  defaultUsageState,
  type UsageChartSeries,
  type UsageFilterOption,
  type UsageFiltersState,
  type UsageRange,
  UsageProvider,
  usageStateAtom,
} from '@/app/usage/usage';
import {
  ApiTestProvider,
  apiTestStateAtom,
  createApiTestState,
  defaultApiTestState,
} from '@/app/api-test/api-test';
import {
  authStateAtom,
  createCredentialsState,
  CredentialsProvider,
  credentialsStateAtom,
  defaultAuthState,
  defaultCredentialsState,
  type AccessKeySummary,
  type CredentialSummary,
} from '@/app/credentials/credentials';
import { type TabKey } from '@/app/page-data';
import { themeAtom, type ThemeMode } from '@/app/page-state';
import { AdminHeader } from '@/app/header';
import { themeChangeEventName } from '@/lib/theme';
import { type LocalePreference } from '@/lib/i18n/routing';
import {
  saveLocalePreference,
  saveThemePreference,
} from '@/lib/client/preferences';

const tabs: Array<{
  icon: typeof LayoutDashboard;
  key: TabKey;
  labelKey:
    'apiTest' | 'credentials' | 'dashboard' | 'debug' | 'settings' | 'usage';
}> = [
  { icon: LayoutDashboard, key: 'dashboard', labelKey: 'dashboard' },
  { icon: ChartLine, key: 'usage', labelKey: 'usage' },
  { icon: KeyRound, key: 'credentials', labelKey: 'credentials' },
  { icon: Send, key: 'api-test', labelKey: 'apiTest' },
  { icon: Bug, key: 'debug', labelKey: 'debug' },
  { icon: Settings2, key: 'settings', labelKey: 'settings' },
];

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
  items?: DebugLogEntry[];
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

interface AdminPageLayoutProps {
  children: ReactNode;
  initialData?: AdminConsoleInitialData;
  initialLocalePreference: LocalePreference;
  initialTab: TabKey;
  initialTheme?: ThemeMode;
  showLogout: boolean;
}

const AdminPageLayoutContent = ({
  children,
  initialData,
  initialLocalePreference,
  initialTab,
  initialTheme = 'system',
  showLogout,
}: AdminPageLayoutProps) => {
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
  const activeTab = initialTab;
  const locale = useLocale();
  const translations = useTranslations('Admin');
  const consoleMessages = translations.raw('console') as Record<string, string>;
  const debugAutoRefreshOptions = [
    {
      label: translations('console.debugAutoRefreshOff'),
      value: 0,
    },
    {
      label: translations('console.debugAutoRefresh5Seconds'),
      value: 5,
    },
    {
      label: translations('console.debugAutoRefresh10Seconds'),
      value: 10,
    },
    {
      label: translations('console.debugAutoRefresh15Seconds'),
      value: 15,
    },
    {
      label: translations('console.debugAutoRefresh30Seconds'),
      value: 30,
    },
    {
      label: translations('console.debugAutoRefresh1Minute'),
      value: 60,
    },
    {
      label: translations('console.debugAutoRefresh2Minutes'),
      value: 120,
    },
    {
      label: translations('console.debugAutoRefresh5Minutes'),
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

    const checkedAt = `${consoleMessages.serviceCheckedAt} ${new Date(
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
        ? consoleMessages.serviceRunning
        : consoleMessages.serviceUnavailable,
      totalApiCalls,
      totalCredentials: items.length,
      uptimeText: checkedAt,
      validCredentials,
    });
  }, [
    consoleMessages.serviceCheckedAt,
    consoleMessages.serviceRunning,
    consoleMessages.serviceUnavailable,
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
        result: current.result || consoleMessages.requestIdle,
      };
    });
  }, [consoleMessages.requestIdle, setApiTest, setSettings]);

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
          getErrorMessage(result.data, consoleMessages.debugLoadFailed),
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
    [consoleMessages.debugLoadFailed, setDebug, showNotification],
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
          getErrorMessage(result.data, consoleMessages.usageLoadFailed),
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
    [consoleMessages.usageLoadFailed, locale, setUsage, showNotification],
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
        getErrorMessage(result.data, consoleMessages.usageClearFailed),
      );
      return;
    }

    showNotification('success', consoleMessages.usageCleared);
    await loadUsage();
  };

  const pollAuth = async (overrideState?: string) => {
    const authState = overrideState ?? auth.authState;

    if (!authState.trim()) {
      showNotification('warning', consoleMessages.authCheckMissing);
      return;
    }

    clearAuthTimer();
    setAuth((current) => ({
      ...current,
      message: consoleMessages.authChecking,
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
        message: result.data?.message ?? consoleMessages.authSuccess,
        polling: false,
      }));
      showNotification(
        'success',
        result.data.message ?? consoleMessages.authSaved,
      );
      await refreshAdminData();
      return;
    }

    if (result.data?.error === 'authorization_pending') {
      setAuth((current) => ({
        ...current,
        message: consoleMessages.authPending,
        polling: false,
      }));
      authPollTimerRef.current = window.setTimeout(() => {
        void pollAuth(authState);
      }, auth.intervalSeconds * 1000);
      return;
    }

    const message = getErrorMessage(
      result.data,
      consoleMessages.authPollFailed,
    );
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
      const message = getErrorMessage(
        result.data,
        consoleMessages.authStartFailed,
      );
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
      message: consoleMessages.authStarted,
      starting: false,
    }));
    showNotification('success', consoleMessages.authCreated);
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
      showNotification('warning', consoleMessages.credentialRequired);
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
        getErrorMessage(result.data, consoleMessages.credentialSaveFailed),
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
      translations('console.credentialSaved', {
        name: result.data.filename ?? 'unknown',
      }),
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
        getErrorMessage(result.data, consoleMessages.credentialDeleteFailed),
      );
      setCredentials((current) => ({
        ...current,
        actionIndex: null,
      }));
      return;
    }

    showNotification('success', consoleMessages.credentialDeleted);
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
          editingId
            ? consoleMessages.apiKeyUpdated
            : consoleMessages.apiKeyCreated,
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
      editingId ? consoleMessages.apiKeyUpdated : consoleMessages.apiKeyCreated,
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
        getErrorMessage(result.data, consoleMessages.apiKeyDeleteFailed),
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
    showNotification('success', consoleMessages.apiKeyDeleted);
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
        getErrorMessage(result.data, consoleMessages.apiKeyReadFailed),
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
    showNotification('success', consoleMessages.apiKeyDisplayed);
  };

  const copyText = async (value: string, successMessage: string) => {
    if (!value.trim()) {
      showNotification('warning', consoleMessages.clipboardEmpty);
      return;
    }

    if (!navigator.clipboard) {
      showNotification('warning', consoleMessages.clipboardUnsupported);
      return;
    }

    await navigator.clipboard.writeText(value);
    showNotification('success', successMessage);
  };

  const submitCallbackUrl = async () => {
    if (!auth.callbackUrl.trim()) {
      showNotification('warning', consoleMessages.authPending);
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
      showNotification('error', consoleMessages.authInvalidCallback);
    }
  };

  const testApi = async () => {
    setApiTest((current) => ({
      ...current,
      result: consoleMessages.requestSending,
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
          'glm-5.1',
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
          getErrorMessage(payload, consoleMessages.requestFailed),
        );
        return;
      } catch {
        setApiTest((current) => ({
          ...current,
          result: text || consoleMessages.requestFailed,
          submitting: false,
        }));
        showNotification('error', consoleMessages.requestFailed);
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
        result: streamedResult || consoleMessages.requestIdle,
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
        getErrorMessage(result.data, consoleMessages.settingsSaveFailed),
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
      result.data?.message ?? consoleMessages.settingsSaved,
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
        getErrorMessage(result.data, consoleMessages.debugSaveFailed),
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
    showNotification(
      'success',
      result.data?.message ?? consoleMessages.debugSaved,
    );
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
        getErrorMessage(result.data, consoleMessages.debugClearFailed),
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
      result.data?.message ?? consoleMessages.debugCleared,
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
      void saveThemePreference(theme, isDark ? 'dark' : 'light');
    };

    applyTheme();

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
    void saveLocalePreference(nextLocale as LocalePreference).finally(() => {
      window.location.reload();
    });
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
            showLogout ? (
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
          className="console-header"
          localePreference={initialLocalePreference}
          onLocaleChange={changeLocale}
          onThemeChange={setTheme}
          theme={theme}
        />
        <main className="console-main">
          <Tabs
            activeKey={activeTab}
            className="console-tabs"
            classNames={{ indicator: 'console-tabs-indicator' }}
            items={tabs.map(({ icon: Icon, key, labelKey }) => {
              const tab = key;

              return {
                icon: <Icon aria-hidden="true" size={16} strokeWidth={2} />,
                key: tab,
                label: translations(`tabs.${labelKey}`),
              };
            })}
            onChange={(key) => {
              router.push(`/${key}` as Route);
            }}
            variant="square"
          />
          {activeTab === 'dashboard' ? (
            <DashboardProvider
              value={{
                dashboard,
                onCopyEndpoint: () => {
                  void copyText(
                    dashboard.apiEndpoint,
                    consoleMessages.copyEndpoint,
                  );
                },
                onRefresh: () => {
                  void loadDashboard();
                },
              }}
            >
              {children}
            </DashboardProvider>
          ) : null}
          {activeTab === 'credentials' ? (
            <CredentialsProvider
              value={{
                auth,
                credentials,
                onAddCredential: () => {
                  void addCredential();
                },
                onAuthAction: () => {
                  void startAuth();
                },
                onCallbackUrlChange: (value) => {
                  setAuth((current) => ({
                    ...current,
                    callbackUrl: value,
                  }));
                },
                onCopyAuthUrl: () => {
                  void copyText(auth.authUrl, consoleMessages.authCopy);
                },
                onCredentialFirstMessageRoleToSystemChange: (value) => {
                  setCredentials((current) => ({
                    ...current,
                    form: {
                      ...current.form,
                      firstMessageRoleToSystem: value,
                    },
                  }));
                },
                onCredentialResponsesPassthroughChange: (value) => {
                  setCredentials((current) => ({
                    ...current,
                    form: {
                      ...current.form,
                      responsesPassthrough: value,
                    },
                  }));
                },
                onCredentialTokenChange: (value) => {
                  setCredentials((current) => ({
                    ...current,
                    form: {
                      ...current.form,
                      bearerToken: value,
                    },
                  }));
                },
                onCredentialUserIdChange: (value) => {
                  setCredentials((current) => ({
                    ...current,
                    form: {
                      ...current.form,
                      userId: value,
                    },
                  }));
                },
                onDeleteCredential: (index) => {
                  void deleteCredential(index);
                },
                onEditCredential: (credential) => {
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
                },
                onDeleteAccessKey: (id) => {
                  void deleteAccessKey(id);
                },
                onEditAccessKey: (accessKey) => {
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
                },
                onOpenAuthUrl: () => {
                  if (!auth.authUrl) {
                    showNotification(
                      'warning',
                      consoleMessages.authLinkMissing,
                    );
                    return;
                  }

                  window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
                },
                onPollAuth: () => {
                  void pollAuth();
                },
                onRefreshAccessKeys: () => {
                  void refreshAccessKeys();
                },
                onRefreshCredentialList: () => {
                  void refreshCredentialList();
                },
                onResetCredentialForm: () => {
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
                },
                onRevealAccessKeySecret: (id) => {
                  void revealAccessKeySecret(id);
                },
                onSaveAccessKey: () => {
                  void saveAccessKey();
                },
                onSubmitCallbackUrl: () => {
                  void submitCallbackUrl();
                },
                onToggleCallbackMode: (showManual) => {
                  setAuth((current) => ({
                    ...current,
                    showManualCallback: showManual,
                  }));
                },
                onToggleCredentialSelection: (filename) => {
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
                },
                onUpdateAccessKeyName: (value) => {
                  setCredentials((current) => ({
                    ...current,
                    accessKeyForm: {
                      ...current.accessKeyForm,
                      name: value,
                    },
                  }));
                },
                onResetAccessKeyForm: () => {
                  setCredentials((current) => ({
                    ...current,
                    accessKeyForm: {
                      credentialFilenames: [],
                      editingId: null,
                      name: '',
                    },
                  }));
                },
              }}
            >
              {children}
            </CredentialsProvider>
          ) : null}
          {activeTab === 'usage' ? (
            <UsageProvider
              value={{
                onAccessKeyChange: (value) => {
                  void loadUsage({ accessKey: value });
                },
                onAutoRefreshSecondsChange: (value) => {
                  setUsage((current) => ({
                    ...current,
                    autoRefreshSeconds: value,
                    autoRefreshVisible: true,
                  }));
                },
                onClearHistory: () => {
                  void clearUsageHistory();
                },
                onCredentialChange: (value) => {
                  void loadUsage({ credential: value });
                },
                onHoverPoint: (point) => {
                  setUsage((current) => ({ ...current, hoveredPoint: point }));
                },
                onRangeChange: (value) => {
                  void loadUsage({ range: value });
                },
                onRefresh: () => {
                  void loadUsage();
                },
                usage,
              }}
            >
              {children}
            </UsageProvider>
          ) : null}
          {activeTab === 'api-test' ? (
            <ApiTestProvider
              value={{
                apiTest,
                credentialOptions: credentials.items.filter(
                  (item) => !item.is_expired,
                ),
                models: String(settings.values.CODEBUDDY_MODELS ?? '')
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
                onCredentialChange: (value) => {
                  setApiTest((current) => ({
                    ...current,
                    credentialFilename: value,
                  }));
                },
                onMessageChange: (value) => {
                  setApiTest((current) => ({ ...current, message: value }));
                },
                onModelChange: (value) => {
                  setApiTest((current) => ({ ...current, model: value }));
                },
                onStreamChange: (value) => {
                  setApiTest((current) => ({ ...current, stream: value }));
                },
                onSubmit: () => {
                  void testApi();
                },
              }}
            >
              {children}
            </ApiTestProvider>
          ) : null}
          {activeTab === 'debug' ? (
            <DebugProvider
              value={{
                autoRefreshOptions: [...debugAutoRefreshOptions],
                debug,
                onAutoRefreshSecondsChange: (value) => {
                  setDebug((current) => ({
                    ...current,
                    autoRefreshSeconds: value,
                  }));
                },
                onClear: () => {
                  void clearDebugItems();
                },
                onCopy: (value) => {
                  void copyText(value, consoleMessages.copyContent);
                },
                onEnabledChange: (value) => {
                  setDebug((current) => ({ ...current, enabled: value }));
                },
                onMaxEntriesChange: (value) => {
                  setDebug((current) => ({
                    ...current,
                    maxEntries: value,
                  }));
                },
                onRefresh: () => {
                  void loadDebug({ preserveSettings: true });
                },
                onSave: () => {
                  void saveDebugSettings();
                },
              }}
            >
              {children}
            </DebugProvider>
          ) : null}
          {activeTab === 'settings' ? (
            <SettingsProvider
              value={{
                onChange: (key, value) => {
                  setSettings((current) => ({
                    ...current,
                    values: { ...current.values, [key]: value },
                  }));
                },
                onSave: () => {
                  void saveSettings();
                },
                settings,
              }}
            >
              {children}
            </SettingsProvider>
          ) : null}
        </main>
      </div>
      <ToastHost duration={3000} position="top-right" />
    </>
  );
};

const AdminPageLayout = (props: AdminPageLayoutProps) => {
  const store = useMemo(() => createStore(), []);

  return (
    <Provider store={store}>
      <AdminPageLayoutContent {...props} />
    </Provider>
  );
};

export default AdminPageLayout;
