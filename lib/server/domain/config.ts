import {
  getFileStorageDir,
  getConfigDir,
  getConfigPath,
  getCredsDir,
  readStorageJson,
  writeStorageJson,
} from '../storage';
import { normalizeFetchBackend, normalizeSearchBackend } from '../search/tool';
import {
  getCredentialSupportedModels,
  listEligibleCredentialRecords,
} from './credentials';

export interface RuntimeConfig {
  CODEBUDDY_API_ENDPOINT: string;
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: string;
  CODEBUDDY_AUTH_MODE: 'auto' | 'token';
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' | 'internal' | 'public';
  CODEBUDDY_LOG_LEVEL: string;
  CODEBUDDY_API_TIMEOUT_MINUTES: number;
  CODEBUDDY_WEB_SEARCH_BACKEND: string;
  CODEBUDDY_WEB_FETCH_BACKEND: string;
  CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: boolean;
}

/**
 * Hy-series models take their thinking depth as `reasoning_effort` with the
 * values `no_think` / `low` / `high` — a vocabulary no downstream client
 * speaks. Claude Code sends Anthropic `thinking`, Codex sends Responses
 * `reasoning.effort`. When this is on, those are translated onto the Hy
 * vocabulary; when off, requests are forwarded exactly as they arrive.
 */

/**
 * Every model id starting with `hy` is a Hy-series model and takes the
 * `reasoning_effort` vocabulary, so matching is a single case-insensitive
 * prefix test rather than an enumeration of known ids: the upstream decides
 * which models exist, and new `hy*` releases should be covered without a code
 * change. `hunyuan-*` is a different prefix and a separate product line, so it
 * is not affected.
 */
export const HY_MODEL_PREFIX = 'hy';

export const isHyModel = (model: string | undefined | null): boolean => {
  if (typeof model !== 'string') return false;

  return model.trim().toLowerCase().startsWith(HY_MODEL_PREFIX);
};

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
  CODEBUDDY_AUTH_MODE: 'auto',
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
  CODEBUDDY_LOG_LEVEL: 'INFO',
  CODEBUDDY_API_TIMEOUT_MINUTES: DEFAULT_API_TIMEOUT_MINUTES,
  CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
  CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
  CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: false,
};
let configMutationQueue: Promise<void> = Promise.resolve();

const SETTING_LABELS_BY_LOCALE: Record<
  ConfigLabelLocale,
  Record<keyof RuntimeConfig, string>
> = {
  'en-US': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy API endpoint',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'Admin passkey RP ID / domain',
    CODEBUDDY_AUTH_MODE: 'Authentication mode (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: 'Network environment (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: 'Log level',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API timeout, first token (minutes)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'Web search backend',
    CODEBUDDY_WEB_FETCH_BACKEND: 'Web fetch backend',
    CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: 'Translate thought depth for Hy models',
  },
  'ja-JP': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy API エンドポイント',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理者 passkey RP ID / ドメイン',
    CODEBUDDY_AUTH_MODE: '認証モード (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: 'ネットワーク環境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: 'ログレベル',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API タイムアウト・最初のトークン (分)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'Web 検索バックエンド',
    CODEBUDDY_WEB_FETCH_BACKEND: 'Web フェッチバックエンド',
    CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: 'Hy モデルの思考深度を変換する',
  },
  'zh-CN': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy 官方 API 端点',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理员 Passkey RP ID / 域名',
    CODEBUDDY_AUTH_MODE: '认证模式 (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: '网络环境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: '日志级别',
    CODEBUDDY_API_TIMEOUT_MINUTES: 'API 超时时间,首个 token(分钟)',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'WebSearch 后端',
    CODEBUDDY_WEB_FETCH_BACKEND: 'WebFetch 后端',
    CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: '为 Hy 系列模型转换思想深度',
  },
};

/**
 * Labels for the settings the console should render.
 *
 * The backend selectors are always shown because CodeBuddy's own endpoints
 * need no deployment-level configuration beyond a credential.
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
    CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED: normalizeValue(
      'CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED',
      persisted.CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED ??
        process.env.CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED,
    ),
  };
};

/**
 * Whether a web search tool call should be executed locally.
 *
 * Derived from the backend choice rather than a separate switch: `none` *is*
 * "off", so a second control would only add a way to contradict it. Resolved per
 * request so a change in the console takes effect at once.
 */
export const isWebSearchEnabled = async (): Promise<boolean> => {
  const config = await getActiveConfig();

  return (
    normalizeSearchBackend(config.CODEBUDDY_WEB_SEARCH_BACKEND) !==
    'passthrough'
  );
};

/**
 * Whether a `web_fetch` tool call should be executed locally, resolved the same
 * way as {@link isWebSearchEnabled}.
 */
export const isWebFetchEnabled = async (): Promise<boolean> => {
  const config = await getActiveConfig();

  return (
    normalizeFetchBackend(config.CODEBUDDY_WEB_FETCH_BACKEND) !== 'passthrough'
  );
};

export const updateSettings = async (
  nextSettings: Partial<Record<keyof RuntimeConfig, unknown>>,
): Promise<RuntimeConfig> => {
  return enqueueConfigMutation(async () => {
    const current = await getActiveConfig();
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
      ...current,
      ...normalizedUpdates,
    };

    await writeStorageJson('config', 'runtime', merged);

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

/**
 * Whether downstream thinking parameters should be translated onto the Hy
 * vocabulary. Resolved per request so toggling the setting in the console takes
 * effect immediately.
 */
export const getHyThoughtDepthEnabled = async (): Promise<boolean> => {
  const config = await getActiveConfig();

  return config.CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED;
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
