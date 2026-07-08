import fs from 'node:fs';
import path from 'node:path';

import { getCredsDir, getRotationCount } from './config';
import { recordCredentialUsage } from './stats';

export type CredentialData = Record<string, unknown> & {
  bearer_token?: string;
  access_token?: string;
  user_id?: string;
  created_at?: number;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  domain?: string;
  session_state?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  tenant_id?: string;
  tenantId?: string;
  user_info?: Record<string, unknown>;
};

type CredentialRecord = {
  filename: string;
  filePath: string;
  data: CredentialData;
};

type ManagerState = {
  currentIndex: number;
  usageCount: number;
  manualSelectedIndex: number | null;
  autoRotationEnabled: boolean;
};

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
      currentIndex: persisted.currentIndex ?? 0,
      usageCount: 0,
      manualSelectedIndex: persisted.manualSelectedIndex ?? null,
      autoRotationEnabled: persisted.autoRotationEnabled ?? true,
    };
  }

  return globalCredentialState.__codebuddy2apiCredentialState__;
};

const saveRuntimeState = (): void => {
  ensureCredsDir();

  const state = getRuntimeState();
  const payload = {
    autoRotationEnabled: state.autoRotationEnabled,
    currentIndex: state.currentIndex,
    manualSelectedIndex: state.manualSelectedIndex,
    savedAt: Math.floor(Date.now() / 1000),
  };

  fs.writeFileSync(getManagerStateFile(), JSON.stringify(payload, null, 2));
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

const readCredentialRecords = (): CredentialRecord[] => {
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

        return [{ filename, filePath, data }];
      } catch {
        return [];
      }
    });
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

const getCredentialStatus = (
  records: CredentialRecord[],
): { records: CredentialRecord[]; indices: number[] } => {
  const validIndices = records.reduce<number[]>((result, record, index) => {
    if (!isCredentialExpired(record.data)) {
      result.push(index);
    }

    return result;
  }, []);

  return { records, indices: validIndices };
};

const getSafeIndex = (records: CredentialRecord[], index: number): number => {
  if (!records.length) {
    return -1;
  }

  if (index >= 0 && index < records.length) {
    return index;
  }

  return 0;
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
        index,
        filename: record.filename,
        user_id:
          record.data.user_id ?? record.data.user_info?.email ?? 'unknown',
        email:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.email ??
          record.data.user_id ??
          'unknown',
        name:
          (record.data.user_info as Record<string, unknown> | undefined)
            ?.name ?? null,
        created_at: record.data.created_at ?? null,
        expires_in: record.data.expires_in ?? null,
        expires_at: expiresAt,
        time_remaining: expiresAt
          ? expiresAt - Math.floor(Date.now() / 1000)
          : null,
        time_remaining_str: formatTimeRemaining(expiresAt),
        is_expired: isCredentialExpired(record.data),
        token_type: record.data.token_type ?? 'Bearer',
        scope: record.data.scope ?? null,
        domain:
          getNestedValue(record.data, ['domain']) ?? 'copilot.tencent.com',
        enterprise_id: enterpriseId,
        tenant_id: tenantId,
        has_refresh_token: Boolean(record.data.refresh_token),
        session_state: record.data.session_state ?? null,
      };
    }),
  };
};

export const getCurrentCredentialInfo = (): Record<string, unknown> => {
  const records = readCredentialRecords();

  if (!records.length) {
    return { status: 'no_credentials' };
  }

  const state = getRuntimeState();
  const index =
    state.manualSelectedIndex ?? getSafeIndex(records, state.currentIndex);
  const record = records[getSafeIndex(records, index)];
  const enterpriseId = getNestedValue(record.data, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getNestedValue(record.data, ['tenant_id', 'tenantId']) ?? enterpriseId;

  return {
    status:
      state.manualSelectedIndex !== null ? 'manual_selected' : 'auto_rotation',
    index,
    filename: record.filename,
    user_id: record.data.user_id ?? 'unknown',
    domain: getNestedValue(record.data, ['domain']) ?? 'copilot.tencent.com',
    enterprise_id: enterpriseId,
    tenant_id: tenantId,
    usage_count: state.usageCount,
    rotation_count: getRotationCount(),
    auto_rotation_enabled: state.autoRotationEnabled,
  };
};

export const addCredential = (
  credentialData: CredentialData,
  filename?: string,
): { success: boolean; filename: string } => {
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
    success: true,
    filename: jsonFilename,
  };
};

export const deleteCredentialByIndex = (
  index: number,
): { success: boolean; message: string } => {
  const records = readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { success: false, message: 'Invalid credential index' };
  }

  fs.unlinkSync(records[index].filePath);

  const state = getRuntimeState();

  if (state.manualSelectedIndex === index) {
    state.manualSelectedIndex = null;
  }

  state.currentIndex = 0;
  state.usageCount = 0;
  saveRuntimeState();

  return { success: true, message: 'Credential deleted' };
};

export const selectCredential = (
  index: number,
): { success: boolean; message: string } => {
  const records = readCredentialRecords();

  if (index < 0 || index >= records.length) {
    return { success: false, message: 'Invalid credential index' };
  }

  const state = getRuntimeState();
  state.manualSelectedIndex = index;
  state.currentIndex = index;
  state.usageCount = 0;
  saveRuntimeState();

  return { success: true, message: 'Credential selected' };
};

export const resumeAutoRotation = (): { success: boolean; message: string } => {
  const state = getRuntimeState();
  state.manualSelectedIndex = null;
  state.autoRotationEnabled = true;
  state.usageCount = 0;
  saveRuntimeState();

  return { success: true, message: 'Automatic rotation resumed' };
};

export const toggleAutoRotation = (): {
  success: boolean;
  auto_rotation_enabled: boolean;
} => {
  const state = getRuntimeState();
  state.autoRotationEnabled = !state.autoRotationEnabled;
  saveRuntimeState();

  return {
    success: true,
    auto_rotation_enabled: state.autoRotationEnabled,
  };
};

export const resolveCredentialForRequest = (): CredentialRecord | null => {
  const records = readCredentialRecords();

  if (!records.length) {
    return null;
  }

  const state = getRuntimeState();
  const { indices } = getCredentialStatus(records);

  if (!indices.length) {
    return null;
  }

  const manualIndex = state.manualSelectedIndex;

  if (
    manualIndex !== null &&
    manualIndex >= 0 &&
    manualIndex < records.length &&
    !isCredentialExpired(records[manualIndex].data)
  ) {
    recordCredentialUsage(records[manualIndex].filename);
    return records[manualIndex];
  }

  if (!indices.includes(state.currentIndex)) {
    state.currentIndex = indices[0];
    state.usageCount = 0;
  }

  const rotationCount = getRotationCount();

  if (!state.autoRotationEnabled || rotationCount <= 0) {
    const current = records[getSafeIndex(records, state.currentIndex)];
    recordCredentialUsage(current.filename);
    return current;
  }

  if (state.usageCount >= rotationCount) {
    const currentPosition = indices.indexOf(state.currentIndex);
    const nextPosition = (currentPosition + 1) % indices.length;
    state.currentIndex = indices[nextPosition];
    state.usageCount = 0;
  }

  const current = records[getSafeIndex(records, state.currentIndex)];
  state.usageCount += 1;
  recordCredentialUsage(current.filename);
  saveRuntimeState();

  return current;
};

export const resetCredentialRuntimeState = (): void => {
  globalCredentialState.__codebuddy2apiCredentialState__ = undefined;
};
