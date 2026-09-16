export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { refreshMissingCredentialModels } =
    await import('@/lib/server/domain/credential-models');
  const { startAutoCheckinScheduler } =
    await import('@/lib/server/domain/auto-checkin-scheduler');

  void refreshMissingCredentialModels();

  // Only in the server process: a build or an edge runtime must not start a
  // timer that would outlive the request it belongs to.
  startAutoCheckinScheduler();
};
