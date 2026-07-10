import fs from 'node:fs';
import path from 'node:path';

import { hasAccessKeys } from './access-keys';
import { getCredsDir } from './config';
import { recordCredentialUsage } from './stats';

export type CredentialData = Record<string, unknown> & {
  access_token?: string;
  bearer_token?: string;
  created_at?: number;
  domain?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  session_state?: string;
  tenant_id?: string;
  tenantId?: string;
  token_type?: string;
  user_id?: string;
  user_info?: Record<string, unknown>;
};

export interface CredentialRecord {
  data: CredentialData;
  filePath: string;
  filename: string;
}

interface ManagerState {
  globalNextFilename: string | null;
  keyNextFilenameByAccessKeyId: Record<string, string | null>;
}

const globalCredentialState = globalThis as typeof globalThis & {
  __codebuddy2apiCredentialState__?: ManagerState;
};

const getManagerStateFile = (): string => {
  return path.join(getCredsDir(), 'manager_state.json');
};

const ensureCredsDir = (): void => {
  fs.mkdirSync(getCredsDir(), { recursive: true });
};

const loadPersistedManagerState = (): Partial<ManagerState> => {
  const filePath = getManagerStateFile();

  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, 'utf8'),
    ) as Partial<ManagerState>;
  } catch {
    return {};
  }
};

const getRuntimeState = (): ManagerState => {
  if (!globalCredentialState.__codebuddy2apiCredentialState__) {
    const persisted = loadPersistedManagerState();
    globalCredentialState.__codebuddy2apiCredentialState__ = {
      globalNextFilename: persisted.globalNextFilename ?? null,
      keyNextFilenameByAccessKeyId:
        persisted.keyNextFilenameByAccessKeyId ?? {},
    };
  }

  return globalCredentialState.__codebuddy2apiCredentialState__;
};

const saveRuntimeState = (): void => {
  ensureCredsDir();

  const state = getRuntimeState();
  fs.writeFileSync(
    getManagerStateFile(),
    JSON.stringify(
      {
        globalNextFilename: state.globalNextFilename,
        keyNextFilenameByAccessKeyId: state.keyNextFilenameByAccessKeyId,
        savedAt: Math.floor(Date.now() / 1000),
      },
      null,
      2,
    ),
  );
};

const getNestedValue = (
  value: unknown,
  candidateKeys: string[],
): string | number | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getNestedValue(item, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }

    return null;
  }

  if (value && typeof value === 'object') {
    for (const key of candidateKeys) {
      const nestedValue = (value as Record<string, unknown>)[key];

      if (
        nestedValue !== undefined &&
        nestedValue !== null &&
        nestedValue !== ''
      ) {
        return nestedValue as string | number;
      }
    }

    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = getNestedValue(nestedValue, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }
  }

  return null;
};

export const readCredentialRecords = (): CredentialRecord[] => {
  ensureCredsDir();

  return fs
    .readdirSync(getCredsDir())
    .filter((item) => item.endsWith('.json') && item !== 'manager_state.json')
    .sort((left, right) => left.localeCompare(right))
    .flatMap((filename) => {
      const filePath = path.join(getCredsDir(), filename);

      try {
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf8'),
        ) as CredentialData;
        const token = data.bearer_token ?? data.access_token;

        if (!token) {
          return [];
        }

        return [{ data, filePath, filename }];
      } catch {
        return [];
      }
    });
};

export const listCredentialFilenames = (): string[] => {
  return readCredentialRecords().map((record) => record.filename);
};

const getCredentialExpiry = (credential: CredentialData): number | null => {
  if (
    typeof credential.created_at !== 'number' ||
    typeof credential.expires_in !== 'number'
  ) {
    return null;
  }

  return credential.created_at + credential.expires_in;
};

const isCredentialExpired = (credential: CredentialData): boolean => {
  const expiresAt = getCredentialExpiry(credential);

  if (!expiresAt) {
    return false;
  }

  return expiresAt - 300 <= Math.floor(Date.now() / 1000);
};

const formatTimeRemaining = (expiresAt: number | null): string => {
  if (!expiresAt) {
    return 'Unknown';
  }

  const remaining = expiresAt - Math.floor(Date.now() / 1000);

  if (remaining <= 0) {
    return 'expired';
  }

  if (remaining < 3600) {
    return `${Math.ceil(remaining / 60)}m`;
  }

  if (remaining < 86400) {
    return `${Math.ceil(remaining / 3600)}h`;
  }

  return `${Math.ceil(remaining / 86400)}d`;
};

const getEligibleRecords = (
  records: CredentialRecord[],
  allowedCredentialFilenames?: string[],
): CredentialRecord[] => {
  const allowedSet = allowedCredentialFilenames?.length
    ? new Set(allowedCredentialFilenames)
    : null;

  return records.filter((record) => {
    if (isCredentialExpired(record.data)) {
      return false;
    }

    if (allowedSet && !allowedSet.has(record.filename)) {
      return false;
    }

    return true;
  });
};

const chooseNextRecord = (
  eligibleRecords: CredentialRecord[],
  nextFilename: string | null,
): { current: CredentialRecord; nextFilename: string } => {
  const currentIndex = nextFilename
    ? eligibleRecords.findIndex((record) => record.filename === nextFilename)
    : -1;
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;
  const current = eligibleRecords[resolvedIndex];
  const nextIndex = (resolvedIndex + 1) % eligibleRecords.length;

  return {
    current,
    nextFilename: eligibleRecords[nextIndex]?.filename ?? current.filename,
  };
};

const peekNextFilename = (
  eligibleRecords: CredentialRecord[],
  nextFilename: string | null,
): string | null => {
  if (!eligibleRecords.length) {
    return null;
  }

  if (
    nextFilename &&
    eligibleRecords.some((record) => record.filename === nextFilename)
  ) {
    return nextFilename;
  }

  return eligibleRecords[0]?.filename ?? null;
};

export const listCredentials = (): {
  credentials: Array<Record<string, unknown>>;
} => {
  const records = readCredentialRecords();

  return {
    credentials: records.map((record, index) => {
      const expiresAt = getCredentialExpiry(record.data);
      const enterpriseId = getNestedValue(record.data, [
        'enterprise_id',
        'enterpriseId',
      ]);
      const tenantId =
        getNestedValue(record.data, ['tenant_id', 'tenantId']) ?? enterpriseId;

      return {
        created_at: record.data.created_at ?? null,
        domain:
          getNestedValue(record.data, ['domain']) ?? 'copilot.tencent.com',
        email:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.email ??
          record.data.user_id ??
          'unknown',
        enterprise_id: enterpriseId,
        expires_at: expiresAt,
        expires_in: record.data.expires_in ?? null,
        filename: record.filename,
        has_refresh_token: Boolean(record.data.refresh_token),
        index,
        is_expired: isCredentialExpired(record.data),
        name:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.name ?? null,
        scope: record.data.scope ?? null,
        session_state: record.data.session_state ?? null,
        tenant_id: tenantId,
        time_remaining: expiresAt
          ? expiresAt - Math.floor(Date.now() / 1000)
          : null,
        time_remaining_str: formatTimeRemaining(expiresAt),
        token_type: record.data.token_type ?? 'Bearer',
        user_id:
          record.data.user_id ?? record.data.user_info?.email ?? 'unknown',
      };
    }),
  };
};

export const getCurrentCredentialInfo = (): Record<string, unknown> => {
  const records = readCredentialRecords();
  const availableRecords = getEligibleRecords(records);
  const state = getRuntimeState();

  if (hasAccessKeys()) {
    return {
      available_credential_count: availableRecords.length,
      next_filename: peekNextFilename(
        availableRecords,
        state.globalNextFilename,
      ),
      status: 'access_keys_enabled',
    };
  }

  if (!availableRecords.length) {
    return { status: 'no_credentials' };
  }

  const nextFilename = peekNextFilename(
    availableRecords,
    state.globalNextFilename,
  );
  const current =
    availableRecords.find((record) => record.filename === nextFilename) ??
    availableRecords[0];
  const enterpriseId = getNestedValue(current.data, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getNestedValue(current.data, ['tenant_id', 'tenantId']) ?? enterpriseId;

  return {
    domain: getNestedValue(current.data, ['domain']) ?? 'copilot.tencent.com',
    enterprise_id: enterpriseId,
    filename: current.filename,
    next_filename: nextFilename,
    status: 'round_robin',
    tenant_id: tenantId,
    user_id: current.data.user_id ?? 'unknown',
  };
};

export const addCredential = (
  credentialData: CredentialData,
  filename?: string,
): { filename: string; success: boolean } => {
  ensureCredsDir();

  const now = Math.floor(Date.now() / 1000);
  const userId = String(credentialData.user_id ?? 'unknown');
  const safeUserId =
    userId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 20) || 'unknown';
  const resolvedFilename = filename ?? `codebuddy_${safeUserId}_${now}.json`;
  const jsonFilename = resolvedFilename.endsWith('.json')
    ? resolvedFilename
    : `${resolvedFilename}.json`;
  const payload = {
    created_at: now,
    ...credentialData,
  };

  fs.writeFileSync(
    path.join(getCredsDir(), jsonFilename),
    JSON.stringify(payload, null, 2),
  );

  saveRuntimeState();

  return {
    filename: jsonFilename,
    success: true,
  };
};

export const deleteCredentialByIndex = (
  index: number,
): { message: string; success: boolean } => {
  const records = readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { message: 'Invalid credential index', success: false };
  }

  fs.unlinkSync(records[index].filePath);

  const state = getRuntimeState();
  const deletedFilename = records[index].filename;

  if (state.globalNextFilename === deletedFilename) {
    state.globalNextFilename = null;
  }

  Object.entries(state.keyNextFilenameByAccessKeyId).forEach(([key, value]) => {
    if (value === deletedFilename) {
      state.keyNextFilenameByAccessKeyId[key] = null;
    }
  });
  saveRuntimeState();

  return { message: 'Credential deleted', success: true };
};

export const selectCredential = (
  index: number,
): { message: string; success: boolean } => {
  const records = readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { message: 'Invalid credential index', success: false };
  }

  const state = getRuntimeState();
  state.globalNextFilename = records[index].filename;
  saveRuntimeState();

  return {
    message: 'Next credential updated for round-robin',
    success: true,
  };
};

export const resumeAutoRotation = (): { message: string; success: boolean } => {
  return {
    message: 'Round-robin is always enabled',
    success: true,
  };
};

export const toggleAutoRotation = (): {
  auto_rotation_enabled: boolean;
  success: boolean;
} => {
  return {
    auto_rotation_enabled: true,
    success: true,
  };
};

export const resolveCredentialForRequest = ({
  accessKeyId,
  allowedCredentialFilenames,
}: {
  accessKeyId?: string;
  allowedCredentialFilenames?: string[];
} = {}): CredentialRecord | null => {
  const records = readCredentialRecords();
  const eligibleRecords = getEligibleRecords(
    records,
    allowedCredentialFilenames,
  );

  if (!eligibleRecords.length) {
    return null;
  }

  const state = getRuntimeState();
  const stateKey = accessKeyId ? `key:${accessKeyId}` : 'global';
  const currentNextFilename = accessKeyId
    ? (state.keyNextFilenameByAccessKeyId[accessKeyId] ?? null)
    : state.globalNextFilename;
  const { current, nextFilename } = chooseNextRecord(
    eligibleRecords,
    currentNextFilename,
  );

  if (stateKey === 'global') {
    state.globalNextFilename = nextFilename;
  } else {
    state.keyNextFilenameByAccessKeyId[accessKeyId!] = nextFilename;
  }

  recordCredentialUsage(current.filename);
  saveRuntimeState();

  return current;
};

export const resetCredentialRuntimeState = (): void => {
  globalCredentialState.__codebuddy2apiCredentialState__ = undefined;
};
