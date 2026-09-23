import {
  getFileStorageDir,
  getConfigDir,
  getConfigPath,
  getCredsDir,
  readStorageJson,
  writeStorageJson,
} from '../storage';
import type {
  FetchBackendSettings,
  SearchBackendSettings,
} from '../search/settings';
import {
  getCredentialSupportedModels,
  listEligibleCredentialRecords,
} from './credentials';

/**
 * One entry per server-tool backend setting, plus the configuration each
 * backend needs.
 *
 * A backend's own settings are ordinary entries in this config rather than
 * environment variables, so every backend is configurable from the console and
 * a deployment never has to restart to point at a different engine.
 */
export interface RuntimeConfig {
  CODEBUDDY_API_ENDPOINT: string;
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: string;
  CODEBUDDY_ADMIN_TRUST_PROXY: boolean;
  CODEBUDDY_AUTH_MODE: 'auto' | 'token';
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' | 'internal' | 'public';
  CODEBUDDY_LOG_LEVEL: string;
  CODEBUDDY_API_TIMEOUT_MINUTES: number;
  CODEBUDDY_WEB_SEARCH_BACKEND: string;
  CODEBUDDY_WEB_FETCH_BACKEND: string;
  CODEBUDDY_SEARXNG_URL: string;
  CODEBUDDY_SEARXNG_API_KEY: string;
  CODEBUDDY_DUCKDUCKGO_REGION: string;
  CODEBUDDY_BRAVE_API_KEY: string;
  CODEBUDDY_TAVILY_API_KEY: string;
  CODEBUDDY_SERPER_API_KEY: string;
  CODEBUDDY_BING_API_KEY: string;
  CODEBUDDY_EXA_API_KEY: string;
  CODEBUDDY_BROWSERABLE_URL: string;
  CODEBUDDY_BROWSERABLE_API_KEY: string;
  CODEBUDDY_JINA_API_KEY: string;
}

/**
 * Budget for a proxied request to produce its first delta, in minutes. It is
 * deliberately generous: a slow model that is thinking still has to clear it,
 * while a hung upstream is cut loose instead of holding a connection forever.
 */
export const DEFAULT_API_TIMEOUT_MINUTES = 5;
export const MIN_API_TIMEOUT_MINUTES = 0.1;
export const MAX_API_TIMEOUT_MINUTES = 1440;
const MINUTE_MS = 60_000;

export type ConfigLabelLocale = 'zh-CN' | 'en-US' | 'ja-JP';

type PersistedConfigFile = Partial<RuntimeConfig>;

const DEFAULT_CONFIG: RuntimeConfig = {
  CODEBUDDY_API_ENDPOINT: 'https://copilot.tencent.com',
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: '',
  CODEBUDDY_ADMIN_TRUST_PROXY: true,
  CODEBUDDY_AUTH_MODE: 'auto',
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
  CODEBUDDY_LOG_LEVEL: 'INFO',
  CODEBUDDY_API_TIMEOUT_MINUTES: DEFAULT_API_TIMEOUT_MINUTES,
  CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
  CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
  CODEBUDDY_SEARXNG_URL: '',
  CODEBUDDY_SEARXNG_API_KEY: '',
  CODEBUDDY_DUCKDUCKGO_REGION: 'wt-wt',
  CODEBUDDY_BRAVE_API_KEY: '',
  CODEBUDDY_TAVILY_API_KEY: '',
  CODEBUDDY_SERPER_API_KEY: '',
  CODEBUDDY_BING_API_KEY: '',
  CODEBUDDY_EXA_API_KEY: '',
  CODEBUDDY_BROWSERABLE_URL: '',
  CODEBUDDY_BROWSERABLE_API_KEY: '',
  CODEBUDDY_JINA_API_KEY: '',
};
let configMutationQueue: Promise<void> = Promise.resolve();

const SETTING_LABELS_BY_LOCALE: Record<
  ConfigLabelLocale,
  Record<keyof RuntimeConfig, string>
> = {
  'en-US': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy API endpoint',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'Admin passkey RP ID / domain',
    CODEBUDDY_ADMIN_TRUST_PROXY: 'Trust X-Forwarded-* headers from a proxy',
    CODEBUDDY_AUTH_MODE: 'Authentication mode (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: 'Network environment (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: 'Log level',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API timeout, first token (minutes)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'Web search backend',
    CODEBUDDY_WEB_FETCH_BACKEND: 'Web fetch backend',
    CODEBUDDY_SEARXNG_URL: 'SearXNG instance address (with port)',
    CODEBUDDY_SEARXNG_API_KEY: 'SearXNG API key',
    CODEBUDDY_DUCKDUCKGO_REGION: 'DuckDuckGo region',
    CODEBUDDY_BRAVE_API_KEY: 'Brave Search API key',
    CODEBUDDY_TAVILY_API_KEY: 'Tavily API key',
    CODEBUDDY_SERPER_API_KEY: 'Serper API key',
    CODEBUDDY_BING_API_KEY: 'Bing API key',
    CODEBUDDY_EXA_API_KEY: 'Exa API key',
    CODEBUDDY_BROWSERABLE_URL: 'Browserable address',
    CODEBUDDY_BROWSERABLE_API_KEY: 'Browserable API key (optional)',
    CODEBUDDY_JINA_API_KEY: 'Jina Reader API key (optional)',
  },
  'ja-JP': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy API エンドポイント',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理者 passkey RP ID / ドメイン',
    CODEBUDDY_ADMIN_TRUST_PROXY:
      'プロキシからの X-Forwarded-* ヘッダーを信頼する',
    CODEBUDDY_AUTH_MODE: '認証モード (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: 'ネットワーク環境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: 'ログレベル',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API タイムアウト・最初のトークン (分)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'Web 検索バックエンド',
    CODEBUDDY_WEB_FETCH_BACKEND: 'Web フェッチバックエンド',
    CODEBUDDY_SEARXNG_URL: 'SearXNG インスタンスのアドレス(ポートを含む)',
    CODEBUDDY_SEARXNG_API_KEY: 'SearXNG API キー',
    CODEBUDDY_DUCKDUCKGO_REGION: 'DuckDuckGo の地域',
    CODEBUDDY_BRAVE_API_KEY: 'Brave Search API キー',
    CODEBUDDY_TAVILY_API_KEY: 'Tavily API キー',
    CODEBUDDY_SERPER_API_KEY: 'Serper API キー',
    CODEBUDDY_BING_API_KEY: 'Bing API キー',
    CODEBUDDY_EXA_API_KEY: 'Exa API キー',
    CODEBUDDY_BROWSERABLE_URL: 'Browserable のアドレス',
    CODEBUDDY_BROWSERABLE_API_KEY: 'Browserable API キー(任意)',
    CODEBUDDY_JINA_API_KEY: 'Jina Reader API キー(任意)',
  },
  'zh-CN': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy 官方 API 端点',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理员 Passkey RP ID / 域名',
    CODEBUDDY_ADMIN_TRUST_PROXY: '信任来自反向代理的 X-Forwarded-* 头',
    CODEBUDDY_AUTH_MODE: '认证模式 (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: '网络环境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: '日志级别',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API 超时时间,首个 token(分钟)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'WebSearch 后端',
    CODEBUDDY_WEB_FETCH_BACKEND: 'WebFetch 后端',
    CODEBUDDY_SEARXNG_URL: 'SearXNG 实例地址(含端口)',
    CODEBUDDY_SEARXNG_API_KEY: 'SearXNG API Key',
    CODEBUDDY_DUCKDUCKGO_REGION: 'DuckDuckGo 区域',
    CODEBUDDY_BRAVE_API_KEY: 'Brave Search API Key',
    CODEBUDDY_TAVILY_API_KEY: 'Tavily API Key',
    CODEBUDDY_SERPER_API_KEY: 'Serper API Key',
    CODEBUDDY_BING_API_KEY: 'Bing API Key',
    CODEBUDDY_EXA_API_KEY: 'Exa API Key',
    CODEBUDDY_BROWSERABLE_URL: 'Browserable 地址',
    CODEBUDDY_BROWSERABLE_API_KEY: 'Browserable API Key(可选)',
    CODEBUDDY_JINA_API_KEY: 'Jina Reader API Key(可选)',
  },
};

/**
 * Labels for the settings the console should render.
 *
 * Every backend is offered. An engine that needs a credential is still listed
 * while its key is empty — the console shows the field to fill in rather than
 * hiding the choice — and it is the backend that declines to run, not the
 * console that declines to offer it.
 */
export const getSettingLabels = (
  locale: ConfigLabelLocale = 'zh-CN',
): Partial<Record<keyof RuntimeConfig, string>> => {
  return SETTING_LABELS_BY_LOCALE[locale];
};

export const SETTING_LABELS = getSettingLabels();

const loadPersistedConfig = async (): Promise<Partial<RuntimeConfig>> => {
  return (
    (await readStorageJson<PersistedConfigFile>('config', 'runtime')) ?? {}
  );
};

const enqueueConfigMutation = async <T>(
  mutation: () => Promise<T>,
): Promise<T> => {
  const operation = configMutationQueue.then(mutation, mutation);
  configMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

/**
 * Numeric settings arrive as strings from the console and as strings from
 * `process.env`, so they are coerced and clamped rather than rejected: a
 * mistyped value should fall back to a sane bound instead of failing the save
 * or, worse, disabling the timeout by parsing to NaN.
 */
const normalizeNumericValue = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === 'number' ? value : Number(String(value).trim());

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    Math.max(parsed, MIN_API_TIMEOUT_MINUTES),
    MAX_API_TIMEOUT_MINUTES,
  );
};

const normalizeValue = <K extends keyof RuntimeConfig>(
  key: K,
  value: unknown,
): RuntimeConfig[K] => {
  const fallback = DEFAULT_CONFIG[key];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof fallback === 'number') {
    return normalizeNumericValue(value, fallback) as RuntimeConfig[K];
  }

  if (typeof fallback === 'string') {
    return String(value) as RuntimeConfig[K];
  }

  // A boolean setting reaches here as a string whenever it comes from the
  // environment or from the console's form payload. Coercing it matters: left
  // as-is, the string "false" is truthy and the setting could never be turned
  // off. Only "true" and "1" read as true, so an unrecognised value fails
  // closed onto the safer of the two readings rather than guessing.
  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') {
      return value as RuntimeConfig[K];
    }

    if (typeof value === 'number') {
      return (value !== 0) as RuntimeConfig[K];
    }

    const normalized = String(value).trim().toLowerCase();

    return (normalized === 'true' || normalized === '1') as RuntimeConfig[K];
  }

  return value as RuntimeConfig[K];
};

export const getActiveConfig = async (): Promise<RuntimeConfig> => {
  const persisted = await loadPersistedConfig();

  return {
    CODEBUDDY_API_ENDPOINT: normalizeValue(
      'CODEBUDDY_API_ENDPOINT',
      persisted.CODEBUDDY_API_ENDPOINT ?? process.env.CODEBUDDY_API_ENDPOINT,
    ),
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: normalizeValue(
      'CODEBUDDY_ADMIN_PASSKEY_RP_ID',
      persisted.CODEBUDDY_ADMIN_PASSKEY_RP_ID ??
        process.env.CODEBUDDY_ADMIN_PASSKEY_RP_ID,
    ),
    CODEBUDDY_ADMIN_TRUST_PROXY: normalizeValue(
      'CODEBUDDY_ADMIN_TRUST_PROXY',
      persisted.CODEBUDDY_ADMIN_TRUST_PROXY ??
        process.env.CODEBUDDY_ADMIN_TRUST_PROXY,
    ),
    CODEBUDDY_AUTH_MODE: normalizeValue(
      'CODEBUDDY_AUTH_MODE',
      persisted.CODEBUDDY_AUTH_MODE ?? process.env.CODEBUDDY_AUTH_MODE,
    ),
    CODEBUDDY_INTERNET_ENVIRONMENT: normalizeValue(
      'CODEBUDDY_INTERNET_ENVIRONMENT',
      persisted.CODEBUDDY_INTERNET_ENVIRONMENT ??
        process.env.CODEBUDDY_INTERNET_ENVIRONMENT,
    ),
    CODEBUDDY_LOG_LEVEL: normalizeValue(
      'CODEBUDDY_LOG_LEVEL',
      persisted.CODEBUDDY_LOG_LEVEL ?? process.env.CODEBUDDY_LOG_LEVEL,
    ),
    CODEBUDDY_API_TIMEOUT_MINUTES: normalizeValue(
      'CODEBUDDY_API_TIMEOUT_MINUTES',
      persisted.CODEBUDDY_API_TIMEOUT_MINUTES ??
        process.env.CODEBUDDY_API_TIMEOUT_MINUTES,
    ),
    CODEBUDDY_WEB_SEARCH_BACKEND: normalizeValue(
      'CODEBUDDY_WEB_SEARCH_BACKEND',
      persisted.CODEBUDDY_WEB_SEARCH_BACKEND ??
        process.env.CODEBUDDY_WEB_SEARCH_BACKEND,
    ),
    CODEBUDDY_WEB_FETCH_BACKEND: normalizeValue(
      'CODEBUDDY_WEB_FETCH_BACKEND',
      persisted.CODEBUDDY_WEB_FETCH_BACKEND ??
        process.env.CODEBUDDY_WEB_FETCH_BACKEND,
    ),
    CODEBUDDY_SEARXNG_URL: normalizeValue(
      'CODEBUDDY_SEARXNG_URL',
      persisted.CODEBUDDY_SEARXNG_URL ?? process.env.CODEBUDDY_SEARXNG_URL,
    ),
    CODEBUDDY_SEARXNG_API_KEY: normalizeValue(
      'CODEBUDDY_SEARXNG_API_KEY',
      persisted.CODEBUDDY_SEARXNG_API_KEY ??
        process.env.CODEBUDDY_SEARXNG_API_KEY,
    ),
    CODEBUDDY_DUCKDUCKGO_REGION: normalizeValue(
      'CODEBUDDY_DUCKDUCKGO_REGION',
      persisted.CODEBUDDY_DUCKDUCKGO_REGION ??
        process.env.CODEBUDDY_DUCKDUCKGO_REGION,
    ),
    CODEBUDDY_BRAVE_API_KEY: normalizeValue(
      'CODEBUDDY_BRAVE_API_KEY',
      persisted.CODEBUDDY_BRAVE_API_KEY ?? process.env.CODEBUDDY_BRAVE_API_KEY,
    ),
    CODEBUDDY_TAVILY_API_KEY: normalizeValue(
      'CODEBUDDY_TAVILY_API_KEY',
      persisted.CODEBUDDY_TAVILY_API_KEY ??
        process.env.CODEBUDDY_TAVILY_API_KEY,
    ),
    CODEBUDDY_SERPER_API_KEY: normalizeValue(
      'CODEBUDDY_SERPER_API_KEY',
      persisted.CODEBUDDY_SERPER_API_KEY ??
        process.env.CODEBUDDY_SERPER_API_KEY,
    ),
    CODEBUDDY_BING_API_KEY: normalizeValue(
      'CODEBUDDY_BING_API_KEY',
      persisted.CODEBUDDY_BING_API_KEY ?? process.env.CODEBUDDY_BING_API_KEY,
    ),
    CODEBUDDY_EXA_API_KEY: normalizeValue(
      'CODEBUDDY_EXA_API_KEY',
      persisted.CODEBUDDY_EXA_API_KEY ?? process.env.CODEBUDDY_EXA_API_KEY,
    ),
    CODEBUDDY_BROWSERABLE_URL: normalizeValue(
      'CODEBUDDY_BROWSERABLE_URL',
      persisted.CODEBUDDY_BROWSERABLE_URL ??
        process.env.CODEBUDDY_BROWSERABLE_URL,
    ),
    CODEBUDDY_BROWSERABLE_API_KEY: normalizeValue(
      'CODEBUDDY_BROWSERABLE_API_KEY',
      persisted.CODEBUDDY_BROWSERABLE_API_KEY ??
        process.env.CODEBUDDY_BROWSERABLE_API_KEY,
    ),
    CODEBUDDY_JINA_API_KEY: normalizeValue(
      'CODEBUDDY_JINA_API_KEY',
      persisted.CODEBUDDY_JINA_API_KEY ?? process.env.CODEBUDDY_JINA_API_KEY,
    ),
  };
};

/**
 * The configuration the `web_search` backends need, for the engine selected in
 * {@link getActiveConfig}.
 *
 * Passed to the registry rather than read there: `search` and this module import
 * each other, so the registry resolving its own settings would close the cycle.
 */
export const getSearchBackendSettings = (
  config: RuntimeConfig,
): SearchBackendSettings => {
  return {
    braveApiKey: config.CODEBUDDY_BRAVE_API_KEY,
    bingApiKey: config.CODEBUDDY_BING_API_KEY,
    duckduckgoRegion: config.CODEBUDDY_DUCKDUCKGO_REGION,
    exaApiKey: config.CODEBUDDY_EXA_API_KEY,
    searxngApiKey: config.CODEBUDDY_SEARXNG_API_KEY,
    searxngUrl: config.CODEBUDDY_SEARXNG_URL,
    serperApiKey: config.CODEBUDDY_SERPER_API_KEY,
    tavilyApiKey: config.CODEBUDDY_TAVILY_API_KEY,
  };
};

/** The configuration the `web_fetch` backends need; see {@link getSearchBackendSettings}. */
export const getFetchBackendSettings = (
  config: RuntimeConfig,
): FetchBackendSettings => {
  return {
    browserableApiKey: config.CODEBUDDY_BROWSERABLE_API_KEY,
    browserableUrl: config.CODEBUDDY_BROWSERABLE_URL,
    jinaApiKey: config.CODEBUDDY_JINA_API_KEY,
  };
};

export const updateSettings = async (
  nextSettings: Partial<Record<keyof RuntimeConfig, unknown>>,
): Promise<RuntimeConfig> => {
  return enqueueConfigMutation(async () => {
    // Merged onto what is already persisted, not onto the effective config.
    // Starting from `getActiveConfig()` would copy every value that came from
    // the environment into runtime.json, where it then outranks that same
    // environment variable forever — the operator could no longer change it
    // without also editing the database. For a security setting specifically
    // meant to be overridable in an emergency, that is a trap.
    const persisted = await loadPersistedConfig();
    const normalizedUpdates = (
      Object.keys(DEFAULT_CONFIG) as Array<keyof RuntimeConfig>
    ).reduce<Partial<RuntimeConfig>>((result, key) => {
      if (!(key in nextSettings)) {
        return result;
      }

      return {
        ...result,
        [key]: normalizeValue(key, nextSettings[key]),
      };
    }, {});
    const merged: RuntimeConfig = {
      ...(await getActiveConfig()),
      ...normalizedUpdates,
    };

    await writeStorageJson('config', 'runtime', {
      ...persisted,
      ...normalizedUpdates,
    });

    return merged;
  });
};

/**
 * Milliseconds a proxied request may spend before its first delta arrives.
 * Resolved per request so a change in the console takes effect immediately
 * instead of requiring a restart.
 */
export const getApiFirstDeltaTimeoutMs = async (): Promise<number> => {
  const config = await getActiveConfig();

  return config.CODEBUDDY_API_TIMEOUT_MINUTES * MINUTE_MS;
};

export const getCodeBuddyApiEndpoint = async (): Promise<string> => {
  const config = await getActiveConfig();
  const explicit = config.CODEBUDDY_API_ENDPOINT.trim();

  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  return config.CODEBUDDY_INTERNET_ENVIRONMENT === 'public'
    ? 'https://www.codebuddy.ai'
    : 'https://copilot.tencent.com';
};

export const getDefaultModel = async (
  fallback = 'glm-5.1',
): Promise<string> => {
  const credentials = await listEligibleCredentialRecords();

  return (
    credentials
      .flatMap((credential) => getCredentialSupportedModels(credential.data))
      .sort((left, right) => left.localeCompare(right))[0] ?? fallback
  );
};

export { getConfigDir, getConfigPath, getCredsDir, getFileStorageDir };
