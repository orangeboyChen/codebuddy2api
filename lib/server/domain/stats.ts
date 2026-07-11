import { listCredentialFilenames } from './credentials';
import { getUsageAnalytics, resetUsageHistory } from './usage';

export const getUsageStats = async (): Promise<{
  credential_usage: Record<string, number>;
  model_usage: Record<string, number>;
}> => {
  const analytics = await getUsageAnalytics({
    range: '7d',
  });
  const modelUsage = analytics.tableRows.reduce<Record<string, number>>(
    (result, row) => {
      result[row.model] = row.callCount;
      return result;
    },
    {},
  );
  const existingCredentialSet = new Set(await listCredentialFilenames());
  const credentialUsage = analytics.filters.credentials
    .filter(
      (item) => item.value !== 'all' && existingCredentialSet.has(item.value),
    )
    .reduce<Record<string, number>>((result, item) => {
      result[item.value] = analytics.credentialCallCounts[item.value] ?? 0;
      return result;
    }, {});

  return {
    credential_usage: credentialUsage,
    model_usage: modelUsage,
  };
};

export const resetUsageStats = async (): Promise<void> => {
  await resetUsageHistory();
};
