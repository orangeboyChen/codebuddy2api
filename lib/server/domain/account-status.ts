import { getCodeBuddyApiEndpoint } from './config';
import {
  listCredentials,
  listEligibleCredentialRecords,
  type CredentialRecord,
} from './credentials';
import { getModelsForCredential } from '../proxy/codebuddy';

export interface AccountStatusSnapshot {
  checkin: { claimed: boolean | null; message: string | null };
  credits: {
    total: number | null;
    used: number | null;
    remaining: number | null;
    plan: string | null;
    resetAt: string | null;
  };
  error: string | null;
  filename: string;
  models: string[];
  queriedAt: string;
}

const getBearerToken = (credential: CredentialRecord): string =>
  String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

const findValue = (value: unknown, keys: string[]): unknown => {
  const record = asRecord(value);
  if (record) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    for (const nested of Object.values(record)) {
      const found = findValue(nested, keys);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const toNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const fetchJson = async (
  credential: CredentialRecord,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> => {
  const domain = String(credential.data.domain ?? '')
    .trim()
    .toLowerCase();
  const endpoint = domain.endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : await getCodeBuddyApiEndpoint();
  const origin = domain.endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn';
  const userId = String(
    credential.data.user_id ?? credential.data.user_info?.email ?? '',
  ).trim();
  const enterpriseId = String(
    credential.data.enterprise_id ?? credential.data.enterpriseId ?? '',
  ).trim();
  const tenantId = String(
    credential.data.tenant_id ?? credential.data.tenantId ?? enterpriseId,
  ).trim();
  const response = await fetch(new URL(path, endpoint), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${getBearerToken(credential)}`,
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: `${origin}/`,
      'User-Agent': 'CLI/2.137.1 CodeBuddy/2.137.1',
      'X-IDE-Name': 'CLI',
      'X-IDE-Type': 'CLI',
      'X-IDE-Version': '2.137.1',
      'X-Product': 'SaaS',
      'X-Requested-With': 'XMLHttpRequest',
      ...(userId ? { 'X-User-Id': userId } : {}),
      ...(enterpriseId ? { 'X-Enterprise-Id': enterpriseId } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
      ...(domain ? { 'X-Domain': domain } : {}),
    },
    method,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
};

const fetchCheckinStatus = async (
  credential: CredentialRecord,
): Promise<unknown> => {
  try {
    return await fetchJson(
      credential,
      '/v2/billing/meter/checkin-activity-status',
      'POST',
      {},
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!error.message.endsWith('returned 404') &&
        !error.message.endsWith('returned 405'))
    ) {
      throw error;
    }
    return fetchJson(
      credential,
      '/v2/billing/meter/checkin-status',
      'POST',
      {},
    );
  }
};

const normalizeQuotaPayload = (payload: unknown): unknown => {
  const accounts = findValue(payload, ['Accounts']);
  if (!Array.isArray(accounts)) return payload;
  let total = 0;
  let used = 0;
  let remaining = 0;
  let hasValues = false;
  for (const account of accounts) {
    const size = toNumber(
      findValue(account, ['CycleCapacitySize', 'CapacitySize']),
    );
    const accountRemaining = toNumber(
      findValue(account, ['CycleCapacityRemain', 'CapacityRemain']),
    );
    const accountUsed = toNumber(
      findValue(account, ['CycleCapacityUsed', 'CapacityUsed']),
    );
    if (size !== null || accountRemaining !== null || accountUsed !== null) {
      hasValues = true;
      total += size ?? (accountRemaining ?? 0) + (accountUsed ?? 0);
      remaining += accountRemaining ?? 0;
      used += accountUsed ?? (size ?? 0) - (accountRemaining ?? 0);
    }
  }
  return hasValues ? { total, used, remaining } : payload;
};

const loadAccountStatus = async (
  credential: CredentialRecord,
): Promise<AccountStatusSnapshot> => {
  const errors: string[] = [];
  let creditsPayload: unknown;
  let checkinPayload: unknown;
  let models: string[] = [];

  try {
    const now = new Date();
    const formatDate = (value: Date) =>
      value.toISOString().slice(0, 19).replace('T', ' ');
    creditsPayload = await fetchJson(
      credential,
      '/v2/billing/meter/get-user-resource',
      'POST',
      {
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: formatDate(now),
        PackageEndTimeRangeEnd: formatDate(
          new Date(now.getTime() + 365 * 101 * 24 * 60 * 60 * 1000),
        ),
      },
    );
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Credits query failed',
    );
  }
  try {
    checkinPayload = await fetchCheckinStatus(credential);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Check-in query failed',
    );
  }
  try {
    const savedModels = String(credential.data.supported_models ?? '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
    models = savedModels.length
      ? savedModels
      : (
          await getModelsForCredential({
            bearerToken: getBearerToken(credential),
            credentialData: credential.data,
          })
        ).map((model) => model.id);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Model query failed');
  }

  const claimedValue = findValue(checkinPayload, [
    'claimed',
    'isClaimed',
    'checkedIn',
    'status',
  ]);
  const claimed =
    typeof claimedValue === 'boolean'
      ? claimedValue
      : typeof claimedValue === 'string'
        ? ['CLAIMED', 'ALREADY_CLAIMED', 'CHECKED_IN'].includes(
            claimedValue.toUpperCase(),
          )
        : null;
  return {
    checkin: {
      claimed,
      message: typeof claimedValue === 'string' ? claimedValue : null,
    },
    credits: {
      total: toNumber(
        findValue(normalizeQuotaPayload(creditsPayload), [
          'total',
          'total_size',
          'quota',
          'TotalDosage',
        ]),
      ),
      used: toNumber(
        findValue(normalizeQuotaPayload(creditsPayload), [
          'used',
          'total_used',
        ]),
      ),
      remaining: toNumber(
        findValue(normalizeQuotaPayload(creditsPayload), [
          'remaining',
          'total_remain',
        ]),
      ),
      plan:
        String(
          findValue(creditsPayload, ['plan', 'planName', 'userType']) ?? '',
        ) || null,
      resetAt:
        String(
          findValue(creditsPayload, ['resetAt', 'reset_at', 'resetTime']) ?? '',
        ) || null,
    },
    error: errors.length ? errors.join('; ') : null,
    filename: credential.filename,
    models,
    queriedAt: new Date().toISOString(),
  };
};

export const getAccountStatus = async (
  filenames?: string[],
): Promise<AccountStatusSnapshot[]> => {
  const credentials = await listEligibleCredentialRecords(filenames);
  const results: AccountStatusSnapshot[] = [];
  for (let index = 0; index < credentials.length; index += 4) {
    const chunk = credentials.slice(index, index + 4);
    results.push(...(await Promise.all(chunk.map(loadAccountStatus))));
  }
  return results;
};

export const getAccountStatusCredentials = async () => {
  const response = await listCredentials();
  return response.credentials;
};

export const checkinAccount = async (
  filename: string,
): Promise<AccountStatusSnapshot> => {
  const credential = (await listEligibleCredentialRecords([filename]))[0];
  if (!credential) throw new Error('Credential is unavailable');
  try {
    await fetchJson(credential, '/v2/billing/meter/daily-checkin', 'POST', {});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Check-in failed';
    return {
      ...(await loadAccountStatus(credential)),
      error: message.replace(
        '/v2/billing/meter/daily-checkin returned',
        'claim returned',
      ),
    };
  }
  return loadAccountStatus(credential);
};

export const checkinAccounts = async (
  filenames?: string[],
): Promise<AccountStatusSnapshot[]> => {
  const credentials = await listEligibleCredentialRecords(filenames);
  const results: AccountStatusSnapshot[] = [];
  for (let index = 0; index < credentials.length; index += 4) {
    const chunk = credentials.slice(index, index + 4);
    results.push(
      ...(await Promise.all(
        chunk.map((credential) => checkinAccount(credential.filename)),
      )),
    );
  }
  return results;
};
