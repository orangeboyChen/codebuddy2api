import crypto from 'node:crypto';

import { readStorageJsonResult, writeStorageJson } from '../storage';

export interface AccessKeyRecord {
  createdAt: string;
  credentialFilenames: string[];
  id: string;
  name: string;
  secret: string;
  updatedAt: string;
}

export interface AccessKeySummary {
  createdAt: string;
  credentialFilenames: string[];
  id: string;
  maskedSecret: string;
  name: string;
  updatedAt: string;
}

interface AccessKeyStore {
  accessKeys: AccessKeyRecord[];
}

type AccessKeyStoreState =
  | { changed: boolean; kind: 'ok'; store: AccessKeyStore }
  | { changed: boolean; kind: 'missing'; store: AccessKeyStore }
  | { changed: boolean; error: string; kind: 'error'; store: AccessKeyStore };

let accessKeyMutationQueue: Promise<void> = Promise.resolve();

const enqueueAccessKeyMutation = async <T>(
  mutation: () => Promise<T>,
): Promise<T> => {
  const operation = accessKeyMutationQueue.then(mutation, mutation);
  accessKeyMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

const normalizeCredentialFilenames = (
  credentialFilenames: string[],
): string[] => {
  return Array.from(
    new Set(credentialFilenames.map((item) => item.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
};

const pruneAccessKeyStore = async (
  store: AccessKeyStore,
): Promise<{ changed: boolean; store: AccessKeyStore }> => {
  let changed = false;
  const accessKeys = await Promise.all(
    store.accessKeys.map(async (record) => {
      const credentialFilenames = normalizeCredentialFilenames(
        record.credentialFilenames,
      );
      const availableFilenames = await Promise.all(
        credentialFilenames.map(async (filename) => {
          const result = await readStorageJsonResult<unknown>(
            'credentials',
            filename,
          );

          return result.exists || result.error ? filename : null;
        }),
      );
      const remainingFilenames = availableFilenames.filter(
        (filename): filename is string => filename !== null,
      );

      if (remainingFilenames.length !== record.credentialFilenames.length) {
        changed = true;
      }

      if (!remainingFilenames.length) {
        changed = true;
        return null;
      }

      if (
        remainingFilenames.some(
          (filename, index) => filename !== record.credentialFilenames[index],
        )
      ) {
        changed = true;
      }

      return {
        ...record,
        credentialFilenames: remainingFilenames,
      };
    }),
  );

  return {
    changed,
    store: {
      accessKeys: accessKeys.filter(
        (record): record is AccessKeyRecord => record !== null,
      ),
    },
  };
};

const readAccessKeyStoreState = async (): Promise<AccessKeyStoreState> => {
  const parsedResult = await readStorageJsonResult<Partial<AccessKeyStore>>(
    'access-keys',
    'store',
  );
  const parsed = parsedResult.value;

  if (parsedResult.error) {
    return {
      changed: false,
      kind: 'error',
      error: parsedResult.error,
      store: { accessKeys: [] },
    };
  }

  if (!parsedResult.exists) {
    return { changed: false, kind: 'missing', store: { accessKeys: [] } };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.accessKeys)
  ) {
    return {
      changed: false,
      error: 'Access key store has an invalid shape',
      kind: 'error',
      store: { accessKeys: [] },
    };
  }

  try {
    const accessKeys = Array.isArray(parsed.accessKeys)
      ? parsed.accessKeys.filter((item): item is AccessKeyRecord => {
          return Boolean(
            item &&
            typeof item === 'object' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string' &&
            typeof item.secret === 'string' &&
            typeof item.createdAt === 'string' &&
            typeof item.updatedAt === 'string' &&
            Array.isArray(item.credentialFilenames),
          );
        })
      : [];

    const normalizedStore = await pruneAccessKeyStore({ accessKeys });

    return {
      changed: normalizedStore.changed,
      kind: 'ok',
      store: normalizedStore.store,
    };
  } catch (error) {
    return {
      changed: false,
      kind: 'error',
      error:
        error instanceof Error
          ? error.message
          : 'Failed to read access key store',
      store: { accessKeys: [] },
    };
  }
};

const readAccessKeyStore = async (): Promise<AccessKeyStore> => {
  return enqueueAccessKeyMutation(async () => {
    const state = await readAccessKeyStoreState();

    if (state.changed) {
      await writeAccessKeyStore(state.store);
    }

    return state.store;
  });
};

const writeAccessKeyStore = async (store: AccessKeyStore): Promise<void> => {
  await writeStorageJson('access-keys', 'store', store);
};

const mutateAccessKeyStore = async <T>(
  mutation: (store: AccessKeyStore) => T | Promise<T>,
): Promise<T> => {
  return enqueueAccessKeyMutation(async () => {
    const state = await readAccessKeyStoreState();
    const result = await mutation(state.store);
    await writeAccessKeyStore(state.store);
    return result;
  });
};

const maskSecret = (secret: string): string => {
  if (secret.length <= 12) {
    return `${secret.slice(0, 4)}****`;
  }

  return `${secret.slice(0, 8)}...${secret.slice(-4)}`;
};

const toSummary = (record: AccessKeyRecord): AccessKeySummary => {
  return {
    createdAt: record.createdAt,
    credentialFilenames: [...record.credentialFilenames],
    id: record.id,
    maskedSecret: maskSecret(record.secret),
    name: record.name,
    updatedAt: record.updatedAt,
  };
};

const generateSecret = (): string => {
  return `cb2_${crypto.randomBytes(32).toString('base64url')}`;
};

export const hasAccessKeys = async (): Promise<boolean> => {
  return (await readAccessKeyStore()).accessKeys.length > 0;
};

export const getAccessKeyStoreError = async (): Promise<string | null> => {
  const state = await readAccessKeyStoreState();
  return state.kind === 'error' ? state.error : null;
};

export const listAccessKeys = async (): Promise<{
  access_keys: AccessKeySummary[];
}> => {
  return {
    access_keys: (await readAccessKeyStore()).accessKeys.map(toSummary),
  };
};

export const listStoredAccessKeys = async (): Promise<AccessKeyRecord[]> => {
  return (await readAccessKeyStore()).accessKeys.map((item) => ({
    ...item,
    credentialFilenames: [...item.credentialFilenames],
  }));
};

export const findAccessKeyById = async (
  id: string,
): Promise<AccessKeyRecord | null> => {
  return (
    (await readAccessKeyStore()).accessKeys.find((item) => item.id === id) ??
    null
  );
};

export const findAccessKeyBySecret = async (
  secret: string,
): Promise<AccessKeyRecord | null> => {
  if (!secret.trim()) {
    return null;
  }

  return (
    (await readAccessKeyStore()).accessKeys.find(
      (item) => item.secret === secret,
    ) ?? null
  );
};

export const createAccessKey = async ({
  credentialFilenames,
  name,
}: {
  credentialFilenames: string[];
  name: string;
}): Promise<{
  access_key: AccessKeySummary;
  secret: string;
}> => {
  const trimmedName = name.trim();
  const normalizedCredentialFilenames =
    normalizeCredentialFilenames(credentialFilenames);

  if (!trimmedName) {
    throw new Error('Access key name is required');
  }

  if (!normalizedCredentialFilenames.length) {
    throw new Error('At least one credential must be selected');
  }

  return mutateAccessKeyStore((store) => {
    const now = new Date().toISOString();
    const record: AccessKeyRecord = {
      createdAt: now,
      credentialFilenames: normalizedCredentialFilenames,
      id: crypto.randomUUID(),
      name: trimmedName,
      secret: generateSecret(),
      updatedAt: now,
    };
    store.accessKeys.push(record);

    return {
      access_key: toSummary(record),
      secret: record.secret,
    };
  });
};

export const updateAccessKey = async (
  id: string,
  {
    credentialFilenames,
    name,
  }: {
    credentialFilenames: string[];
    name: string;
  },
): Promise<AccessKeySummary> => {
  const trimmedName = name.trim();
  const normalizedCredentialFilenames =
    normalizeCredentialFilenames(credentialFilenames);

  if (!trimmedName) {
    throw new Error('Access key name is required');
  }

  if (!normalizedCredentialFilenames.length) {
    throw new Error('At least one credential must be selected');
  }

  return mutateAccessKeyStore((store) => {
    const record = store.accessKeys.find((item) => item.id === id);

    if (!record) {
      throw new Error('Access key not found');
    }

    record.name = trimmedName;
    record.credentialFilenames = normalizedCredentialFilenames;
    record.updatedAt = new Date().toISOString();

    return toSummary(record);
  });
};

export const deleteAccessKey = async (id: string): Promise<boolean> => {
  return mutateAccessKeyStore((store) => {
    const nextAccessKeys = store.accessKeys.filter((item) => item.id !== id);

    if (nextAccessKeys.length === store.accessKeys.length) {
      return false;
    }

    store.accessKeys = nextAccessKeys;
    return true;
  });
};

export const removeCredentialReferencesFromAccessKeys = async (
  credentialFilename: string,
): Promise<boolean> => {
  return mutateAccessKeyStore((store) => {
    let changed = false;
    const accessKeys = store.accessKeys.flatMap((record) => {
      const credentialFilenames = normalizeCredentialFilenames(
        record.credentialFilenames,
      ).filter((filename) => filename !== credentialFilename);

      if (credentialFilenames.length !== record.credentialFilenames.length) {
        changed = true;
      }

      if (!credentialFilenames.length) {
        changed = true;
        return [];
      }

      if (
        credentialFilenames.some(
          (filename, index) => filename !== record.credentialFilenames[index],
        )
      ) {
        changed = true;
      }

      return [{ ...record, credentialFilenames }];
    });

    if (!changed) {
      return false;
    }

    store.accessKeys = accessKeys;
    return true;
  });
};

export const getAccessKeySecret = async (
  id: string,
): Promise<{ id: string; name: string; secret: string } | null> => {
  const record = await findAccessKeyById(id);

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    secret: record.secret,
  };
};
