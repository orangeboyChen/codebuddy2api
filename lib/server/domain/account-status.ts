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
): Promise<unknown> => {
  const response = await fetch(new URL(path, await getCodeBuddyApiEndpoint()), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${getBearerToken(credential)}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
};

const loadAccountStatus = async (
  credential: CredentialRecord,
): Promise<AccountStatusSnapshot> => {
  const errors: string[] = [];
  let creditsPayload: unknown;
  let checkinPayload: unknown;
  let models: string[] = [];

  try {
    creditsPayload = await fetchJson(credential, '/api/v2/quota/usage');
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Credits query failed',
    );
  }
  try {
    checkinPayload = await fetchJson(
      credential,
      '/sash/api/v1/me/daily-check-in/status',
    );
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : 'Check-in query failed',
    );
  }
  try {
    models = (
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
        findValue(creditsPayload, ['total', 'total_size', 'quota']),
      ),
      used: toNumber(findValue(creditsPayload, ['used', 'total_used'])),
      remaining: toNumber(
        findValue(creditsPayload, ['remaining', 'total_remain']),
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
    await fetchJson(credential, '/sash/api/v1/me/daily-check-in/claim', 'POST');
  } catch (error) {
    return {
      ...(await loadAccountStatus(credential)),
      error: error instanceof Error ? error.message : 'Check-in failed',
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
