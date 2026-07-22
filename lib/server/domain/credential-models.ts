import {
  getCredentialSupportedModels,
  listEligibleCredentialRecords,
  updateCredentialSupportedModels,
} from './credentials';
import { getModelsByCredential } from '../proxy/codebuddy';

const globalCredentialModelRefreshState = globalThis as typeof globalThis & {
  __codebuddy2apiCredentialModelRefresh__?: Promise<void>;
};

export const refreshMissingCredentialModels = (): Promise<void> => {
  if (
    !globalCredentialModelRefreshState.__codebuddy2apiCredentialModelRefresh__
  ) {
    globalCredentialModelRefreshState.__codebuddy2apiCredentialModelRefresh__ =
      (async () => {
        try {
          const credentials = await listEligibleCredentialRecords();
          const missingModels = credentials.filter(
            (credential) =>
              getCredentialSupportedModels(credential.data).length === 0,
          );

          await Promise.allSettled(
            missingModels.map(async (credential) => {
              const result = await getModelsByCredential([credential]);
              const models = result[credential.filename]?.models ?? [];

              if (models.length) {
                await updateCredentialSupportedModels(
                  credential.filename,
                  models.map((model) => model.id),
                );
              }
            }),
          );
        } catch (error) {
          console.warn(
            '[CodeBuddy2API] Unable to refresh missing credential models',
            error,
          );
        }
      })();
  }

  return globalCredentialModelRefreshState.__codebuddy2apiCredentialModelRefresh__;
};
