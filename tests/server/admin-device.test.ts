import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The device authorization grant, end to end.
 *
 * What is worth covering here is the waiting: a device that asks before the user
 * has approved is told to ask again, a code that has run out is answered the same
 * as one that was never issued — because telling them apart would only say which
 * codes were ever handed out — and the token is minted once, for the one device
 * that asked while the approval was still good.
 */

const mocks = vi.hoisted(() => {
  const docs = new Map<string, unknown>();
  const readError: { value: string | null } = { value: null };
  const writeError: { value: Error | null } = { value: null };

  return {
    docs,
    readError,
    writeError,
    readStorageJsonResult: vi.fn(async (namespace: string, key: string) => ({
      error: readError.value,
      exists: docs.has(`${namespace}/${key}`),
      value: docs.get(`${namespace}/${key}`) ?? null,
    })),
    writeStorageJson: vi.fn(
      async (namespace: string, key: string, value: unknown) => {
        if (writeError.value) {
          throw writeError.value;
        }

        docs.set(`${namespace}/${key}`, value);
      },
    ),
  };
});

vi.mock('@/lib/server/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/storage')>()),
  readStorageJsonResult: mocks.readStorageJsonResult,
  writeStorageJson: mocks.writeStorageJson,
}));

const {
  clampPollIntervalSeconds,
  deviceBearerToken,
  exchangeDeviceGrant,
  approveDeviceGrant,
  isDeviceGrantType,
  isDeviceTokenAuthorized,
  normalizeUserCode,
  requestDeviceAuthorization,
  revokeDeviceToken,
} = await import('@/lib/server/admin/device');
const { DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } =
  await import('@/lib/server/admin/device-client');

const ORIGIN = 'https://admin.example.com';
const STORE_KEY = 'admin-device/grants';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

interface StoredShape {
  grants: Array<Record<string, unknown>>;
  tokens: Array<Record<string, unknown>>;
}

const stored = (): StoredShape =>
  (mocks.docs.get(STORE_KEY) as StoredShape | undefined) ?? {
    grants: [],
    tokens: [],
  };

const seed = (value: StoredShape): void => {
  mocks.docs.set(STORE_KEY, value);
};

const grantEntry = (overrides: Record<string, unknown> = {}) => ({
  clientId: DEVICE_CLIENT_ID,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  status: 'pending',
  // The code the user types is kept as a hash too, so a read of the file is not
  // a way to approve a grant nobody approved.
  userCodeHash: sha256(normalizeUserCode('AAAA-BBBB')),
  ...overrides,
});

const bearer = (token: string): Request =>
  new Request(`${ORIGIN}/admin-api/usage`, {
    headers: { authorization: `Bearer ${token}` },
  });

/** A code nobody typed yet, and the token it is exchanged for once they have. */
const issueAndApprove = async (): Promise<{
  deviceCode: string;
  token: string;
  userCode: string;
}> => {
  const authorization = await requestDeviceAuthorization({ origin: ORIGIN });
  const { user_code: userCode } = authorization;
  const { device_code: deviceCode } = authorization;

  await approveDeviceGrant({ userCode });

  const exchanged = await exchangeDeviceGrant({ deviceCode });

  if ('error' in exchanged) {
    throw new Error(`expected a token, got ${exchanged.error}`);
  }

  return { deviceCode, token: exchanged.access_token, userCode };
};

describe('the codes a device starts from', () => {
  beforeEach(() => {
    mocks.docs.clear();
    mocks.readError.value = null;
    mocks.writeError.value = null;
  });

  it('answers with a code to poll with and one to show a person', async () => {
    const authorization = await requestDeviceAuthorization({ origin: ORIGIN });

    expect(authorization.device_code).toMatch(/^[\w-]{20,}$/);
    expect(authorization.user_code).toMatch(
      /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/,
    );
    expect(authorization.expires_in).toBe(600);
    expect(authorization.interval).toBe(5);
  });

  it('sends the user to this console’s own page, with the code already in it', async () => {
    const { verification_uri: uri } = await requestDeviceAuthorization({
      origin: ORIGIN,
    });

    expect(uri).toBe(`${ORIGIN}/device`);

    const withSlash = await requestDeviceAuthorization({
      origin: `${ORIGIN}/`,
    });

    expect(withSlash.verification_uri).toBe(`${ORIGIN}/device`);
    expect(withSlash.verification_uri_complete).toBe(
      `${ORIGIN}/device?user_code=${withSlash.user_code}`,
    );
  });

  it('keeps the hash of the code it polled with, never the code', async () => {
    const { device_code: deviceCode, user_code: userCode } =
      await requestDeviceAuthorization({ origin: ORIGIN });

    expect(JSON.stringify(stored())).not.toContain(deviceCode);
    expect(JSON.stringify(stored())).not.toContain(userCode);
    expect(stored().grants[0]?.deviceCodeHash).toBe(sha256(deviceCode));
    expect(stored().grants[0]?.deviceCodeHash).not.toBe(deviceCode);
    expect(stored().grants[0]?.userCodeHash).toBe(
      sha256(normalizeUserCode(userCode)),
    );
  });

  it('has nothing to approve when storage cannot be written to', async () => {
    mocks.writeError.value = new Error('disk is full');

    await expect(
      requestDeviceAuthorization({ origin: ORIGIN }),
    ).rejects.toThrow();
  });

  it('reads a grant another version wrote, with nothing but the code in it', async () => {
    seed({
      grants: [
        grantEntry({
          clientId: undefined,
          createdAt: undefined,
          deviceCodeHash: sha256('older-code'),
          status: undefined,
        }),
      ],
      tokens: [],
    });

    await expect(
      approveDeviceGrant({ userCode: 'AAAA-BBBB' }),
    ).resolves.toEqual({ clientId: DEVICE_CLIENT_ID, status: 'approved' });
    await expect(
      exchangeDeviceGrant({ deviceCode: 'older-code' }),
    ).resolves.toMatchObject({ token_type: 'Bearer' });
  });
});

describe('approving a code', () => {
  beforeEach(() => {
    mocks.docs.clear();
    mocks.readError.value = null;
    mocks.writeError.value = null;
  });

  it('approves the code however it was typed', async () => {
    const { user_code: userCode } = await requestDeviceAuthorization({
      origin: ORIGIN,
    });

    await expect(
      approveDeviceGrant({ userCode: ` ${userCode.toLowerCase()} ` }),
    ).resolves.toEqual({ clientId: DEVICE_CLIENT_ID, status: 'approved' });
    await expect(
      approveDeviceGrant({ userCode: userCode.replace('-', '') }),
    ).resolves.toEqual({ clientId: DEVICE_CLIENT_ID, status: 'approved' });
  });

  it('does not approve a code this console never issued', async () => {
    await requestDeviceAuthorization({ origin: ORIGIN });

    await expect(
      approveDeviceGrant({ userCode: 'ZZZZ-ZZZZ' }),
    ).resolves.toEqual({
      clientId: '',
      status: 'missing',
    });
  });

  it('has nothing to approve in an empty code', async () => {
    await expect(approveDeviceGrant({ userCode: '   ' })).resolves.toEqual({
      clientId: '',
      status: 'missing',
    });
    await expect(
      approveDeviceGrant({ userCode: 42 as never }),
    ).resolves.toEqual({
      clientId: '',
      status: 'missing',
    });
  });

  it('is not signed in by a console whose storage will not answer', async () => {
    const { token } = await issueAndApprove();

    mocks.readError.value = 'storage is unreadable';

    await expect(isDeviceTokenAuthorized(bearer(token))).resolves.toBe(false);
  });
});

describe('the token a device asks for', () => {
  beforeEach(() => {
    mocks.docs.clear();
    mocks.readError.value = null;
    mocks.writeError.value = null;
  });

  it('says to ask again while the user has not approved', async () => {
    const { device_code: deviceCode } = await requestDeviceAuthorization({
      origin: ORIGIN,
    });

    await expect(exchangeDeviceGrant({ deviceCode })).resolves.toEqual({
      error: 'authorization_pending',
    });
  });

  it('hands a token over once the user has approved', async () => {
    const { token } = await issueAndApprove();

    expect(token).toMatch(/^[\w-]{20,}$/);
    expect(stored().tokens).toHaveLength(1);
    expect(JSON.stringify(stored())).not.toContain(token);
    expect(stored().tokens[0]?.tokenHash).toBe(sha256(token));
  });

  it('spends the code on the first device that asks for it', async () => {
    const { deviceCode } = await issueAndApprove();

    await expect(exchangeDeviceGrant({ deviceCode })).resolves.toEqual({
      error: 'expired_token',
    });
  });

  it('answers the same for a code that ran out and one never issued', async () => {
    seed({
      grants: [
        grantEntry({
          deviceCodeHash: sha256('ran-out'),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          status: 'approved',
        }),
      ],
      tokens: [],
    });

    await expect(
      exchangeDeviceGrant({ deviceCode: 'ran-out' }),
    ).resolves.toEqual({ error: 'expired_token' });
    await expect(exchangeDeviceGrant({ deviceCode: 'never' })).resolves.toEqual(
      {
        error: 'expired_token',
      },
    );
  });

  it('does not exchange a code that was not sent', async () => {
    await expect(exchangeDeviceGrant({ deviceCode: '' })).resolves.toEqual({
      error: 'invalid_grant',
    });
  });

  it('stores the token under the client that asked for the code', async () => {
    const authorization = await requestDeviceAuthorization({
      clientId: 'another-client',
      origin: ORIGIN,
    });

    await approveDeviceGrant({ userCode: authorization.user_code });
    await exchangeDeviceGrant({ deviceCode: authorization.device_code });

    expect(stored().tokens[0]?.clientId).toBe('another-client');
  });
});

describe('a request a device sent', () => {
  beforeEach(() => {
    mocks.docs.clear();
    mocks.readError.value = null;
    mocks.writeError.value = null;
  });

  it('is the admin when it carries a token this console handed out', async () => {
    const { token } = await issueAndApprove();

    await expect(isDeviceTokenAuthorized(bearer(token))).resolves.toBe(true);
  });

  it('is nobody at all without a token', async () => {
    await expect(
      isDeviceTokenAuthorized(new Request(`${ORIGIN}/admin-api/usage`)),
    ).resolves.toBe(false);
    await expect(isDeviceTokenAuthorized(bearer('not-a-token'))).resolves.toBe(
      false,
    );
  });

  it('is nobody once the token has run out', async () => {
    const { token } = await issueAndApprove();

    seed({
      grants: [],
      tokens: stored().tokens.map((entry) => ({
        ...entry,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      })),
    });

    await expect(isDeviceTokenAuthorized(bearer(token))).resolves.toBe(false);
  });

  it('reads the bearer token whatever shape the header came in', () => {
    expect(deviceBearerToken(bearer('  token  '))).toBe('token');
    expect(
      deviceBearerToken(
        new Request(ORIGIN, {
          headers: { authorization: 'bearer spaced out' },
        }),
      ),
    ).toBe('spacedout');
    expect(
      deviceBearerToken(
        new Request(ORIGIN, { headers: { authorization: 'Basic abc' } }),
      ),
    ).toBeNull();
    expect(
      deviceBearerToken(
        new Request(ORIGIN, { headers: { authorization: '' } }),
      ),
    ).toBeNull();
  });

  it('forgets the token it came in with when the device signs out', async () => {
    const { token } = await issueAndApprove();

    await expect(revokeDeviceToken(bearer(token))).resolves.toBe(true);
    await expect(isDeviceTokenAuthorized(bearer(token))).resolves.toBe(false);
    await expect(revokeDeviceToken(bearer(token))).resolves.toBe(false);
    await expect(
      revokeDeviceToken(new Request(`${ORIGIN}/admin-api/oauth/token`)),
    ).resolves.toBe(false);
  });

  // The window carries both: a cookie the deployment set once, and the token
  // the user approved in a browser. A cookie that names a session this
  // deployment no longer has — signed out elsewhere, or expired — must not be
  // the end of the question, or every request in that state is answered 401
  // until somebody clears the cookie by hand.
  it('is the admin even when the cookie it came with is stale', async () => {
    const { token } = await issueAndApprove();
    const { isAdminSessionAuthenticated } =
      await import('@/lib/server/admin/session');

    const request = new Request(`${ORIGIN}/admin-api/usage`, {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: 'admin_session=a-session-that-is-gone',
      },
    });

    await expect(isAdminSessionAuthenticated(request)).resolves.toBe(true);
  });

  it('is nobody with a stale cookie and no token', async () => {
    const { isAdminSessionAuthenticated } =
      await import('@/lib/server/admin/session');

    const request = new Request(`${ORIGIN}/admin-api/usage`, {
      headers: { cookie: 'admin_session=a-session-that-is-gone' },
    });

    await expect(isAdminSessionAuthenticated(request)).resolves.toBe(false);
  });
});

describe('what a client is told', () => {
  it('recognises the grant type a device exchanges a code with', () => {
    expect(isDeviceGrantType(DEVICE_GRANT_TYPE)).toBe(true);
    expect(isDeviceGrantType('authorization_code')).toBe(false);
    expect(isDeviceGrantType(undefined)).toBe(false);
  });

  it('keeps the interval it waits between its floor and its ceiling', () => {
    expect(clampPollIntervalSeconds(7)).toBe(7);
    expect(clampPollIntervalSeconds('7')).toBe(7);
    expect(clampPollIntervalSeconds(0)).toBe(1);
    expect(clampPollIntervalSeconds(600)).toBe(30);
    expect(clampPollIntervalSeconds('soon')).toBe(5);
    expect(clampPollIntervalSeconds(undefined)).toBe(5);
  });

  it('reads a code in one shape whatever was typed around it', () => {
    expect(normalizeUserCode('abcd efgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode('AB-CD')).toBe('ABCD');
    expect(normalizeUserCode('')).toBe('');
    expect(normalizeUserCode(null)).toBe('');
  });
});
