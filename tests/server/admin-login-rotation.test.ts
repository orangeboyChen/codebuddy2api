import { randomBytes, scryptSync } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression cover for the sign-in / password-rotation race.
 *
 * Verifying the password against a state snapshot taken before the scrypt
 * call, then appending the session in a later mutation, leaves a window where
 * the previous password still mints a session that survives the rotation.
 * The check has to happen inside the serialized mutation, against the state
 * that mutation just read.
 */

const mocks = vi.hoisted(() => ({
  readStorageJsonResult: vi.fn(),
  writeStorageJson: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/storage')>();

  return {
    ...actual,
    readStorageJsonResult: mocks.readStorageJsonResult,
    writeStorageJson: mocks.writeStorageJson,
  };
});

const { loginWithAdminPassword } = await import('@/lib/server/admin/session');

const CURRENT_PASSWORD = 'current-password';
const NEXT_PASSWORD = 'rotated-password';

interface AdminAuthState {
  enabled: boolean;
  passkeys: unknown[];
  password: { hash: string; salt: string; updatedAt: string } | null;
  pendingChallenges: unknown[];
  sessions: unknown[];
  username: string;
}

const makePasswordRecord = (password: string) => {
  const salt = randomBytes(16).toString('hex');

  return {
    hash: scryptSync(password, salt, 64).toString('hex'),
    salt,
    updatedAt: new Date().toISOString(),
  };
};

const makeState = (password: string): AdminAuthState => ({
  enabled: true,
  passkeys: [],
  password: makePasswordRecord(password),
  pendingChallenges: [],
  sessions: [],
  username: 'admin',
});

const makeRequest = (): Request => {
  return new Request('https://admin.example.com/admin-api/auth/password', {
    headers: { host: 'admin.example.com' },
  });
};

describe('admin sign-in during a password rotation', () => {
  beforeEach(() => {
    mocks.readStorageJsonResult.mockReset();
    mocks.writeStorageJson.mockClear();
  });

  it('rejects the previous password when the rotation lands mid-verification', async () => {
    // The first read is the snapshot the handler takes before hashing; every
    // later read — including the one the session mutation performs — sees the
    // rotated password.
    mocks.readStorageJsonResult.mockImplementation(
      async (namespace: string) => {
        if (namespace !== 'admin-auth') {
          return { error: null, exists: false, value: null };
        }

        const calls = mocks.readStorageJsonResult.mock.calls.filter(
          (call) => (call[0] as string) === 'admin-auth',
        ).length;

        return {
          error: null,
          exists: true,
          value:
            calls <= 1 ? makeState(CURRENT_PASSWORD) : makeState(NEXT_PASSWORD),
        };
      },
    );

    const response = await loginWithAdminPassword(
      makeRequest(),
      'admin',
      CURRENT_PASSWORD,
    );

    expect(response.status).toBe(401);
    // The mutation still persists the pruned state, but it must not carry a
    // session: the whole point of the race is a session minted with the
    // previous password.
    const lastWrite = mocks.writeStorageJson.mock.calls.at(-1) as
      unknown[] | undefined;
    const written = lastWrite?.[2] as { sessions: unknown[] } | undefined;

    expect(written?.sessions).toHaveLength(0);
  });

  it('still accepts the password when nothing rotated', async () => {
    // One fixed state: nothing rotates, so the snapshot and the read inside
    // the mutation must see the same password record.
    const unchanged = makeState(CURRENT_PASSWORD);
    mocks.readStorageJsonResult.mockImplementation(
      async (namespace: string) => {
        if (namespace !== 'admin-auth') {
          return { error: null, exists: false, value: null };
        }

        // A fresh copy every read: the mutation re-loads from storage, so it
        // sees a different object with identical fields. Returning the same
        // object would let an identity comparison pass where a field
        // comparison is what keeps normal sign-ins working.
        return { error: null, exists: true, value: { ...unchanged } };
      },
    );

    const response = await loginWithAdminPassword(
      makeRequest(),
      'admin',
      CURRENT_PASSWORD,
    );

    expect(response.status).toBe(200);
    expect(mocks.writeStorageJson).toHaveBeenCalled();
  });
});
