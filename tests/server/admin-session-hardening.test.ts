import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  beginAdminPasskeyRegistration,
  isAdminSessionAuthenticated,
  loginWithAdminPassword,
  setupAdminPassword,
} from '@/lib/server/admin/session';
import {
  readStorageJson,
  resetStorageRuntime as resetStorageLayer,
  writeStorageJson,
} from '@/lib/server/storage';

interface StoredSession {
  createdAt: string;
  expiresAt: string;
  id: string;
  lastUsedAt: string;
  tokenHash: string;
}
interface StoredState {
  enabled: boolean;
  passkeys: unknown[];
  password: unknown;
  pendingChallenges: unknown[];
  sessions: StoredSession[];
  username: string;
}
type ThrottleMap = Map<string, { failures: number; firstFailureAt: number }>;

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-admin-session-hardening');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeRequest = (
  pathname: string,
  init?: {
    cookie?: string;
    forwardedFor?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    host?: string;
    protocol?: 'http' | 'https';
    realIp?: string;
  },
) => {
  const protocol = init?.protocol ?? 'http';
  const host = init?.host ?? 'localhost:3000';
  const headers: Record<string, string> = { host };

  if (init?.cookie) {
    headers.cookie = init.cookie;
  }

  if (init?.forwardedHost) {
    headers['x-forwarded-host'] = init.forwardedHost;
  }

  if (init?.forwardedProto) {
    headers['x-forwarded-proto'] = init.forwardedProto;
  }

  if (init?.forwardedFor) {
    headers['x-forwarded-for'] = init.forwardedFor;
  }

  if (init?.realIp) {
    headers['x-real-ip'] = init.realIp;
  }

  return new Request(`${protocol}://${host}${pathname}`, { headers });
};

const getCookieHeader = (response: Response) => {
  return response.headers.get('set-cookie') ?? '';
};

const readState = async (): Promise<StoredState> => {
  return (await readStorageJson<StoredState>(
    'admin-auth',
    'state',
  )) as StoredState;
};

/**
 * The throttle map is process-wide state, so tests read it directly instead of
 * inferring what it holds from response codes.
 */
const getThrottleMap = (): ThrottleMap | undefined => {
  return (
    globalThis as typeof globalThis & {
      __codebuddy2apiAdminLoginThrottle__?: ThrottleMap;
    }
  ).__codebuddy2apiAdminLoginThrottle__;
};

const readCookieToken = (cookieHeader: string): string => {
  const match = cookieHeader.match(/codebuddy_admin_session=([^;]+)/);

  return match ? decodeURIComponent(match[1]) : '';
};

const hashToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};

const setupAdmin = async (): Promise<string> => {
  const response = await setupAdminPassword(
    makeRequest('/admin-api/auth/setup'),
    'correct horse battery staple',
  );

  return getCookieHeader(response);
};

describe('admin session hardening', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageLayer();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PERSISTENCE;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_ADMIN_PASSKEY_RP_ID;
    delete process.env.CODEBUDDY_ADMIN_TRUST_PROXY;
    getThrottleMap()?.clear();
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('reads the first value of a comma separated forwarded protocol', async () => {
    // Two proxy hops produce "https, http"; comparing the whole header used to
    // fail, which silently dropped `Secure` from the session cookie.
    const cookie = await setupAdmin();

    const response = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', {
        cookie,
        forwardedProto: 'https, http',
      }),
      'correct horse battery staple',
    );

    expect(response.status).toBe(200);
    expect(getCookieHeader(response)).toContain('Secure');
  });

  it('derives the passkey rp id from the first forwarded host', async () => {
    const cookie = await setupAdmin();

    const response = await beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options', {
        cookie,
        forwardedHost: 'admin.example.com, proxy.internal',
        forwardedProto: 'https',
        host: 'admin.example.com',
        protocol: 'https',
      }),
      'Primary key',
    );
    const payload = (await response.json()) as {
      options: { rp: { id: string } };
    };

    expect(response.status).toBe(200);
    expect(payload.options.rp.id).toBe('admin.example.com');

    // A forwarded host that is blank (or only a separator) falls back to Host.
    const fallbackResponse = await beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options', {
        cookie,
        forwardedHost: ', proxy.internal',
        forwardedProto: 'https',
        host: 'admin.example.com',
        protocol: 'https',
      }),
      'Fallback key',
    );
    const fallbackPayload = (await fallbackResponse.json()) as {
      options: { rp: { id: string } };
    };

    expect(fallbackPayload.options.rp.id).toBe('admin.example.com');
  });

  it('ignores forwarded headers when proxy trust is disabled', async () => {
    // A directly exposed server must not let a client choose the origin the
    // passkey is bound to, nor talk it out of a `Secure` cookie.
    process.env.CODEBUDDY_ADMIN_TRUST_PROXY = 'false';

    try {
      const cookie = await setupAdmin();

      const response = await beginAdminPasskeyRegistration(
        makeRequest('/admin-api/auth/passkeys/registration/options', {
          cookie,
          forwardedHost: 'attacker.example.com',
          forwardedProto: 'http',
          host: 'admin.example.com',
          protocol: 'https',
        }),
        'Primary key',
      );
      const payload = (await response.json()) as {
        options: { rp: { id: string } };
      };

      expect(response.status).toBe(200);
      expect(payload.options.rp.id).toBe('admin.example.com');

      const loginResponse = await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          cookie,
          forwardedProto: 'http',
          host: 'admin.example.com',
          protocol: 'https',
        }),
        'correct horse battery staple',
      );

      expect(loginResponse.status).toBe(200);
      expect(getCookieHeader(loginResponse)).toContain('Secure');
    } finally {
      delete process.env.CODEBUDDY_ADMIN_TRUST_PROXY;
    }
  });

  it('throttles repeated failed sign-ins per username and source', async () => {
    await setupAdmin();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '203.0.113.9',
        }),
        'wrong-password',
      );

      expect(response.status).toBe(401);
    }

    const throttled = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', { forwardedFor: '203.0.113.9' }),
      'correct horse battery staple',
    );

    expect(throttled.status).toBe(429);
    await expect(throttled.json()).resolves.toMatchObject({
      error: { code: 'admin_login_rate_limited' },
    });

    // Another source address still has its own budget.
    const otherSource = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', { forwardedFor: '203.0.113.10' }),
      'correct horse battery staple',
    );

    expect(otherSource.status).toBe(200);
  });

  it('clears the throttle counter after a successful sign-in', async () => {
    await setupAdmin();

    const fail = async () => {
      const response = await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '198.51.100.7',
        }),
        'wrong-password',
      );

      expect(response.status).toBe(401);
    };

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await fail();
    }

    expect(
      (
        await loginWithAdminPassword(
          makeRequest('/admin-api/auth/session', {
            forwardedFor: '198.51.100.7',
          }),
          'correct horse battery staple',
        )
      ).status,
    ).toBe(200);

    // Without the reset, the second batch would cross the limit and 429.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await fail();
    }

    expect(
      (
        await loginWithAdminPassword(
          makeRequest('/admin-api/auth/session', {
            forwardedFor: '198.51.100.7',
          }),
          'correct horse battery staple',
        )
      ).status,
    ).toBe(200);
  });

  it('sweeps throttle counters whose window has elapsed', async () => {
    await setupAdmin();
    const start = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(start);

    try {
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '203.0.113.9',
        }),
        'wrong-password',
      );
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '198.51.100.7',
        }),
        'wrong-password',
      );
      expect(getThrottleMap()?.size).toBe(2);

      const later = start + 16 * 60 * 1000;
      nowSpy.mockReturnValue(later);

      // The expired counter for the address that comes back is dropped when it
      // is checked; the one for the other address is swept when this failure is
      // recorded, so the map cannot grow forever.
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '203.0.113.9',
        }),
        'wrong-password',
      );

      const throttles = getThrottleMap();
      expect(throttles?.size).toBe(1);
      expect(throttles?.has('admin|198.51.100.7')).toBe(false);
      expect(throttles?.get('admin|203.0.113.9')).toEqual({
        failures: 1,
        firstFailureAt: later,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('falls back to x-real-ip, and to one bucket when no proxy is trusted', async () => {
    await setupAdmin();

    await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', { realIp: '203.0.113.11' }),
      'wrong-password',
    );
    expect(getThrottleMap()?.has('admin|203.0.113.11')).toBe(true);

    process.env.CODEBUDDY_ADMIN_TRUST_PROXY = 'false';

    try {
      // Without a trusted proxy a client-supplied address is not a separate
      // bucket, otherwise it could hand itself a fresh budget every attempt.
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: '203.0.113.12',
        }),
        'wrong-password',
      );

      expect(getThrottleMap()?.has('admin|203.0.113.12')).toBe(false);
      expect(getThrottleMap()?.get('admin|unknown')?.failures).toBe(1);
    } finally {
      delete process.env.CODEBUDDY_ADMIN_TRUST_PROXY;
    }
  });

  it('caps stored sessions and drops the oldest ones', async () => {
    await setupAdmin();
    const state = await readState();
    const base = Date.now() - 60 * 60 * 1000;
    const fabricated: StoredSession[] = Array.from(
      { length: 60 },
      (_, index) => {
        const createdAt = new Date(base + index).toISOString();

        return {
          createdAt,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          id: `session-${index}`,
          lastUsedAt: createdAt,
          tokenHash: hashToken(`token-${index}`),
        };
      },
    );

    await writeStorageJson('admin-auth', 'state', {
      ...state,
      sessions: [...fabricated, ...state.sessions],
    });

    const response = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session'),
      'correct horse battery staple',
    );

    expect(response.status).toBe(200);

    const nextState = await readState();
    expect(nextState.sessions).toHaveLength(50);
    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', {
          cookie: 'codebuddy_admin_session=token-0',
        }),
      ),
    ).toBe(false);
    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', {
          cookie: 'codebuddy_admin_session=token-59',
        }),
      ),
    ).toBe(true);
  });

  it('refreshes lastUsedAt only when it is stale', async () => {
    const cookie = await setupAdmin();
    const sessionCookie = `codebuddy_admin_session=${readCookieToken(cookie)}`;
    const initial = (await readState()).sessions[0];

    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', { cookie: sessionCookie }),
      ),
    ).toBe(true);
    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', { cookie: sessionCookie }),
      ),
    ).toBe(true);

    // A recently used session is recognised without rewriting the document.
    expect((await readState()).sessions[0].lastUsedAt).toBe(initial.lastUsedAt);

    const state = await readState();
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    await writeStorageJson('admin-auth', 'state', {
      ...state,
      sessions: state.sessions.map((entry) => {
        return { ...entry, lastUsedAt: stale };
      }),
    });

    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', { cookie: sessionCookie }),
      ),
    ).toBe(true);

    const refreshed = (await readState()).sessions[0];

    expect(refreshed.lastUsedAt).not.toBe(stale);
    expect(new Date(refreshed.lastUsedAt).getTime()).toBeGreaterThan(
      new Date(stale).getTime(),
    );
  });

  it('does not recognise an expired or missing session', async () => {
    const cookie = await setupAdmin();
    const sessionCookie = `codebuddy_admin_session=${readCookieToken(cookie)}`;
    const state = await readState();

    await writeStorageJson('admin-auth', 'state', {
      ...state,
      sessions: state.sessions.map((entry) => {
        return {
          ...entry,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        };
      }),
    });

    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', { cookie: sessionCookie }),
      ),
    ).toBe(false);
    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', {
          cookie: 'codebuddy_admin_session=unknown',
        }),
      ),
    ).toBe(false);
    expect(
      await isAdminSessionAuthenticated(makeRequest('/admin-api/settings')),
    ).toBe(false);
  });
});
