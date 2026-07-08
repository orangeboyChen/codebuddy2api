type UsageStats = {
  modelUsage: Record<string, number>;
  credentialUsage: Record<string, number>;
};

type StatsStore = {
  stats: UsageStats;
};

const globalStats = globalThis as typeof globalThis & {
  __codebuddy2apiStats__?: StatsStore;
};

const getStatsStore = (): StatsStore => {
  if (!globalStats.__codebuddy2apiStats__) {
    globalStats.__codebuddy2apiStats__ = {
      stats: {
        modelUsage: {},
        credentialUsage: {},
      },
    };
  }

  return globalStats.__codebuddy2apiStats__;
};

export const recordModelUsage = (model: string): void => {
  const store = getStatsStore();
  store.stats.modelUsage[model] = (store.stats.modelUsage[model] ?? 0) + 1;
};

export const recordCredentialUsage = (credentialId: string): void => {
  const store = getStatsStore();
  store.stats.credentialUsage[credentialId] =
    (store.stats.credentialUsage[credentialId] ?? 0) + 1;
};

export const getUsageStats = (): {
  model_usage: Record<string, number>;
  credential_usage: Record<string, number>;
} => {
  const store = getStatsStore();

  return {
    model_usage: { ...store.stats.modelUsage },
    credential_usage: { ...store.stats.credentialUsage },
  };
};

export const resetUsageStats = (): void => {
  const store = getStatsStore();
  store.stats.modelUsage = {};
  store.stats.credentialUsage = {};
};
