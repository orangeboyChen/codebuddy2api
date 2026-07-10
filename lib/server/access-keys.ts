import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir } from './config';

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
  | { kind: 'ok'; store: AccessKeyStore }
  | { kind: 'missing'; store: AccessKeyStore }
  | { kind: 'error'; error: string; store: AccessKeyStore };

const getAccessKeysPath = (): string => {
  return path.join(getConfigDir(), 'access-keys.json');
};

const ensureConfigDir = (): void => {
  fs.mkdirSync(getConfigDir(), { recursive: true });
};

const readAccessKeyStoreState = (): AccessKeyStoreState => {
  const filePath = getAccessKeysPath();

  if (!fs.existsSync(filePath)) {
    return { kind: 'missing', store: { accessKeys: [] } };
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<AccessKeyStore>;
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

    return {
      kind: 'ok',
      store: { accessKeys },
    };
  } catch (error) {
    return {
      kind: 'error',
      error:
        error instanceof Error
          ? error.message
          : 'Failed to read access key store',
      store: { accessKeys: [] },
    };
  }
};

const readAccessKeyStore = (): AccessKeyStore => {
  return readAccessKeyStoreState().store;
};

const writeAccessKeyStore = (store: AccessKeyStore): void => {
  ensureConfigDir();
  fs.writeFileSync(getAccessKeysPath(), JSON.stringify(store, null, 2));
};

const normalizeCredentialFilenames = (
  credentialFilenames: string[],
): string[] => {
  return Array.from(
    new Set(credentialFilenames.map((item) => item.trim()).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right));
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

export const hasAccessKeys = (): boolean => {
  return readAccessKeyStore().accessKeys.length > 0;
};

export const getAccessKeyStoreError = (): string | null => {
  const state = readAccessKeyStoreState();
  return state.kind === 'error' ? state.error : null;
};

export const listAccessKeys = (): { access_keys: AccessKeySummary[] } => {
  return {
    access_keys: readAccessKeyStore().accessKeys.map(toSummary),
  };
};

export const listStoredAccessKeys = (): AccessKeyRecord[] => {
  return readAccessKeyStore().accessKeys.map((item) => ({
    ...item,
    credentialFilenames: [...item.credentialFilenames],
  }));
};

export const findAccessKeyById = (id: string): AccessKeyRecord | null => {
  return readAccessKeyStore().accessKeys.find((item) => item.id === id) ?? null;
};

export const findAccessKeyBySecret = (
  secret: string,
): AccessKeyRecord | null => {
  if (!secret.trim()) {
    return null;
  }

  return (
    readAccessKeyStore().accessKeys.find((item) => item.secret === secret) ??
    null
  );
};

export const createAccessKey = ({
  credentialFilenames,
  name,
}: {
  credentialFilenames: string[];
  name: string;
}): {
  access_key: AccessKeySummary;
  secret: string;
} => {
  const trimmedName = name.trim();
  const normalizedCredentialFilenames =
    normalizeCredentialFilenames(credentialFilenames);

  if (!trimmedName) {
    throw new Error('Access key name is required');
  }

  if (!normalizedCredentialFilenames.length) {
    throw new Error('At least one credential must be selected');
  }

  const now = new Date().toISOString();
  const record: AccessKeyRecord = {
    createdAt: now,
    credentialFilenames: normalizedCredentialFilenames,
    id: crypto.randomUUID(),
    name: trimmedName,
    secret: generateSecret(),
    updatedAt: now,
  };
  const store = readAccessKeyStore();
  store.accessKeys.push(record);
  writeAccessKeyStore(store);

  return {
    access_key: toSummary(record),
    secret: record.secret,
  };
};

export const updateAccessKey = (
  id: string,
  {
    credentialFilenames,
    name,
  }: {
    credentialFilenames: string[];
    name: string;
  },
): AccessKeySummary => {
  const trimmedName = name.trim();
  const normalizedCredentialFilenames =
    normalizeCredentialFilenames(credentialFilenames);

  if (!trimmedName) {
    throw new Error('Access key name is required');
  }

  if (!normalizedCredentialFilenames.length) {
    throw new Error('At least one credential must be selected');
  }

  const store = readAccessKeyStore();
  const record = store.accessKeys.find((item) => item.id === id);

  if (!record) {
    throw new Error('Access key not found');
  }

  record.name = trimmedName;
  record.credentialFilenames = normalizedCredentialFilenames;
  record.updatedAt = new Date().toISOString();
  writeAccessKeyStore(store);

  return toSummary(record);
};

export const deleteAccessKey = (id: string): boolean => {
  const store = readAccessKeyStore();
  const nextAccessKeys = store.accessKeys.filter((item) => item.id !== id);

  if (nextAccessKeys.length === store.accessKeys.length) {
    return false;
  }

  writeAccessKeyStore({ accessKeys: nextAccessKeys });
  return true;
};

export const getAccessKeySecret = (
  id: string,
): { id: string; name: string; secret: string } | null => {
  const record = findAccessKeyById(id);

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    secret: record.secret,
  };
};
