import {
  getFileStorageDir,
  getConfigDir,
  getConfigPath,
  getCredsDir,
  readStorageJson,
  writeStorageJson,
} from '../storage';

export interface RuntimeConfig {
  CODEBUDDY_API_ENDPOINT: string;
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: string;
  CODEBUDDY_AUTH_MODE: 'auto' | 'token';
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' | 'internal' | 'public';
  CODEBUDDY_LOG_LEVEL: string;
  CODEBUDDY_MODELS: string;
}

export type ConfigLabelLocale = 'zh-CN' | 'en-US' | 'ja-JP';

type PersistedConfigFile = Partial<RuntimeConfig>;

const DEFAULT_CONFIG: RuntimeConfig = {
  CODEBUDDY_API_ENDPOINT: 'https://copilot.tencent.com',
  CODEBUDDY_ADMIN_PASSKEY_RP_ID: '',
  CODEBUDDY_AUTH_MODE: 'auto',
  CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa',
  CODEBUDDY_LOG_LEVEL: 'INFO',
  CODEBUDDY_MODELS:
    'glm-5.1,glm-5.0,glm-5.0-turbo,glm-5v-turbo,glm-4.7,minimax-m3-play,minimax-m2.7,minimax-m2.5,kimi-k2.6,kimi-k2.5,hy3-preview-agent,deepseek-v4-pro,deepseek-v4-flash,deepseek-v3-2-volc,claude-sonnet-4.6,claude-opus-4.8,claude-opus-4.8-1m,claude-opus-4.7,claude-opus-4.7-1m,claude-opus-4.6,claude-opus-4.6-1m,claude-haiku-4.5,gemini-3.1-pro,gemini-3.5-flash,gemini-2.5-pro,gpt-5.5,gpt-5.4,gpt-5.3-codex,gpt-5.1-codex,gpt-5.1-codex-mini,glm-5.2-ioa,glm-5v-turbo-ioa,glm-5.0-ioa,glm-4.7-ioa,minimax-m3-ioa,minimax-m2.7-ioa,minimax-m2.5-ioa,kimi-k2.6-ioa,hy3-preview-agent-ioa,deepseek-v4-pro-ioa,deepseek-v4-flash-ioa,deepseek-v3-2-volc-ioa',
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
    CODEBUDDY_MODELS: 'Available models (comma-separated)',
  },
  'ja-JP': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy API エンドポイント',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理者 passkey RP ID / ドメイン',
    CODEBUDDY_AUTH_MODE: '認証モード (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: 'ネットワーク環境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: 'ログレベル',
    CODEBUDDY_MODELS: '利用可能なモデル一覧 (カンマ区切り)',
  },
  'zh-CN': {
    CODEBUDDY_API_ENDPOINT: 'CodeBuddy 官方 API 端点',
    CODEBUDDY_ADMIN_PASSKEY_RP_ID: '管理员 Passkey RP ID / 域名',
    CODEBUDDY_AUTH_MODE: '认证模式 (auto/token)',
    CODEBUDDY_INTERNET_ENVIRONMENT: '网络环境 (internal/ioa/public)',
    CODEBUDDY_LOG_LEVEL: '日志级别',
    CODEBUDDY_MODELS: '可用模型列表 (逗号分隔)',
  },
};

export const getSettingLabels = (
  locale: ConfigLabelLocale = 'zh-CN',
): Record<keyof RuntimeConfig, string> => {
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

const normalizeValue = <K extends keyof RuntimeConfig>(
  key: K,
  value: unknown,
): RuntimeConfig[K] => {
  const fallback = DEFAULT_CONFIG[key];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (typeof fallback === 'string') {
    return String(value) as RuntimeConfig[K];
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
    CODEBUDDY_MODELS: normalizeValue(
      'CODEBUDDY_MODELS',
      persisted.CODEBUDDY_MODELS ?? process.env.CODEBUDDY_MODELS,
    ),
  };
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

export const getAvailableModels = async (): Promise<string[]> => {
  return (await getActiveConfig()).CODEBUDDY_MODELS.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

export const getDefaultModel = async (
  fallback = 'glm-5.1',
): Promise<string> => {
  return (await getAvailableModels())[0] ?? fallback;
};

export { getConfigDir, getConfigPath, getCredsDir, getFileStorageDir };
