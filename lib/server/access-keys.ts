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

const getAccessKeysPath = (): string => {
  return path.join(getConfigDir(), 'access-keys.json');
};

const ensureConfigDir = (): void => {
  fs.mkdirSync(getConfigDir(), { recursive: true });
};

const readAccessKeyStore = (): AccessKeyStore => {
  const filePath = getAccessKeysPath();

  if (!fs.existsSync(filePath)) {
    return { accessKeys: [] };
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<AccessKeyStore>;
    return {
      accessKeys: Array.isArray(parsed.accessKeys)
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
        : [],
    };
  } catch {
    return { accessKeys: [] };
  }
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
  const target = store.accessKeys.find((item) => item.id === id);

  if (!target) {
    throw new Error('Access key not found');
  }

  target.name = trimmedName;
  target.credentialFilenames = normalizedCredentialFilenames;
  target.updatedAt = new Date().toISOString();
  writeAccessKeyStore(store);

  return toSummary(target);
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
  const target = findAccessKeyById(id);

  if (!target) {
    return null;
  }

  return {
    id: target.id,
    name: target.name,
    secret: target.secret,
  };
};
