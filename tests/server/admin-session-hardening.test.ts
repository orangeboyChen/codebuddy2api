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

const SETUP_PASSWORD = 'correct horse battery staple';

const setupAdmin = async (): Promise<string> => {
  const response = await setupAdminPassword(
    makeRequest('/admin-api/auth/setup'),
    SETUP_PASSWORD,
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

  /**
   * Buckets are keyed on the username alone: `X-Forwarded-For` is supplied by
   * the client whenever no proxy we control is in front of us, so charging
   * failures to it lets a caller hand itself a fresh budget per request.
   */
  const throttleKeyFor = (username: string): string => {
    return createHash('sha256')
      .update(username.trim().toLowerCase())
      .digest('hex');
  };

  it('throttles repeated failed sign-ins for one username', async () => {
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
  });

  it('does not hand out a fresh budget to a spoofed forwarded address', async () => {
    await setupAdmin();

    // The regression this guards: a per-address bucket lets an attacker rotate
    // `X-Forwarded-For` and guess passwords without limit, because the header
    // is attacker-controlled on a directly exposed instance.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session', {
          forwardedFor: `203.0.113.${attempt}`,
        }),
        'wrong-password',
      );

      expect(response.status).toBe(401);
    }

    const spoofed = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', { forwardedFor: '198.51.100.1' }),
      'correct horse battery staple',
    );

    expect(spoofed.status).toBe(429);

    // Spoofing a real-IP header must not help either.
    const spoofedRealIp = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session', { realIp: '198.51.100.2' }),
      'correct horse battery staple',
    );

    expect(spoofedRealIp.status).toBe(429);
  });

  it('gives each username its own budget', async () => {
    await setupAdmin();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session'),
        'admin',
        'wrong-password',
      );
    }

    expect(
      (
        await loginWithAdminPassword(
          makeRequest('/admin-api/auth/session'),
          'admin',
          SETUP_PASSWORD,
        )
      ).status,
    ).toBe(429);

    // A different username is a separate bucket: it is still evaluated (401)
    // rather than being caught by the exhausted one (429).
    expect(
      (
        await loginWithAdminPassword(
          makeRequest('/admin-api/auth/session'),
          'someone-else',
          'wrong-password',
        )
      ).status,
    ).toBe(401);
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
          SETUP_PASSWORD,
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
          SETUP_PASSWORD,
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
        makeRequest('/admin-api/auth/session'),
        'admin',
        'wrong-password',
      );
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session'),
        'other-admin',
        'wrong-password',
      );
      expect(getThrottleMap()?.size).toBe(2);

      const later = start + 16 * 60 * 1000;
      nowSpy.mockReturnValue(later);

      // The expired counter for the username that comes back is dropped when
      // it is checked; the other is swept when this failure is recorded, so
      // the map cannot keep growing once an attacker stops sending.
      await loginWithAdminPassword(
        makeRequest('/admin-api/auth/session'),
        'admin',
        'wrong-password',
      );

      const throttles = getThrottleMap();
      expect(throttles?.size).toBe(1);
      expect(throttles?.has(throttleKeyFor('other-admin'))).toBe(false);
      expect(throttles?.get(throttleKeyFor('admin'))).toEqual({
        failures: 1,
        firstFailureAt: later,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('bounds the throttle map when usernames are sprayed', async () => {
    await setupAdmin();
    const throttles = getThrottleMap();
    const now = Date.now();

    // Filled the way an attacker spraying usernames would end up filling it,
    // but without paying for ten thousand real sign-in attempts: each of those
    // reads the auth document, which is slow enough to flake the suite.
    for (let index = 0; index < 10_000; index += 1) {
      throttles?.set(`spray-${index}`, { failures: 1, firstFailureAt: now });
    }

    expect(throttles?.size).toBe(10_000);

    // One more failure has to fit without growing the map, and the username
    // being attacked must be the one that survives.
    await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session'),
      'admin',
      'wrong-password',
    );

    expect(throttles?.size).toBe(10_000);
    expect(throttles?.has(throttleKeyFor('admin'))).toBe(true);
  });

  it('caps stored sessions and drops the oldest ones', async () => {
    await setupAdmin();
    const state = await readState();
    // Ahead of this instance's clock on purpose: instances sharing a database
    // do not share a clock, and a session stamped by a lagging instance must
    // not be the one evicted.
    const base = Date.now() + 60 * 60 * 1000;
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
      SETUP_PASSWORD,
    );

    expect(response.status).toBe(200);
    const issuedCookie = getCookieHeader(response);

    const nextState = await readState();
    expect(nextState.sessions).toHaveLength(50);

    // The assertion this case exists for: the session just handed out must be
    // the one that survives. Every fabricated session is stamped ahead of this
    // instance's clock, so an implementation that evicts purely by createdAt
    // drops the newest sign-in while still passing the length and token-59
    // checks below.
    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', { cookie: issuedCookie }),
      ),
    ).toBe(true);
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
