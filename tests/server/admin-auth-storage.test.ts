import fs from 'node:fs';
import path from 'node:path';

import {
  beginAdminPasskeyAuthentication,
  beginAdminPasskeyRegistration,
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
  hasAdminAccount,
  hasAdminAccountAsync,
  hasAdminPassword,
  isAdminSessionAuthenticated,
  listAdminPasskeys,
  loginWithAdminPassword,
  logoutAdminSession,
  setupAdminPassword,
} from '@/lib/server/admin/session';
import {
  deleteStorageJson,
  ensureStorageReady,
  getStorageBackendMeta,
  listStorageJson,
  readStorageJson,
  readStorageJsonResult,
  resetStorageRuntime as resetStorageLayer,
  writeStorageJson,
} from '@/lib/server/storage';
import {
  pollCodeBuddyAuth,
  startCodeBuddyAuth,
} from '@/lib/server/proxy/codebuddy-auth';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-admin-auth-storage');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeRequest = (
  pathname: string,
  init?: {
    cookie?: string;
    host?: string;
    protocol?: 'http' | 'https';
  },
) => {
  const protocol = init?.protocol ?? 'http';
  const host = init?.host ?? 'localhost:3000';

  return new Request(`${protocol}://${host}${pathname}`, {
    headers: {
      ...(init?.cookie ? { cookie: init.cookie } : {}),
      host,
      'x-forwarded-host': host,
      'x-forwarded-proto': protocol,
    },
  });
};

const getCookieHeader = (response: Response) => {
  return response.headers.get('set-cookie') ?? '';
};

describe('admin auth and storage', () => {
  beforeEach(() => {
    cleanupTempState();
    resetStorageLayer();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PERSISTENCE;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_ADMIN_PASSKEY_RP_ID;
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('throws on legacy sync helper and manages password session lifecycle', async () => {
    expect(() => hasAdminAccount()).toThrow('Use hasAdminAccountAsync');

    expect(await hasAdminAccountAsync()).toBe(false);
    expect(await hasAdminPassword()).toBe(false);
    expect(await listAdminPasskeys()).toEqual([]);
    expect(
      await getAdminSessionErrorResponse(makeRequest('/admin-api/settings')),
    ).toBeNull();

    const shortPasswordResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'short',
    );
    expect(shortPasswordResponse.status).toBe(400);

    const setupResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    expect(setupResponse.status).toBe(200);
    const setupCookie = getCookieHeader(setupResponse);
    expect(setupCookie).toContain('codebuddy_admin_session=');
    expect(await hasAdminAccountAsync()).toBe(true);
    expect(await hasAdminPassword()).toBe(true);

    const unauthenticatedError = await getAdminSessionErrorResponse(
      makeRequest('/admin-api/settings'),
    );
    expect(unauthenticatedError?.status).toBe(401);

    expect(
      await isAdminSessionAuthenticated(
        makeRequest('/admin-api/settings', {
          cookie: setupCookie,
        }),
      ),
    ).toBe(true);

    const summary = await getAdminSessionSummary(
      makeRequest('/admin-api/auth/session', {
        cookie: setupCookie,
      }),
    );
    expect(summary.accountConfigured).toBe(true);
    expect(summary.authenticated).toBe(true);
    expect(summary.passwordConfigured).toBe(true);

    const duplicateSetupResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'another strong password',
    );
    expect(duplicateSetupResponse.status).toBe(409);

    const wrongPasswordResponse = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session'),
      'wrong-password',
    );
    expect(wrongPasswordResponse.status).toBe(401);

    const loginResponse = await loginWithAdminPassword(
      makeRequest('/admin-api/auth/session'),
      'correct horse battery staple',
    );
    expect(loginResponse.status).toBe(200);
    const loginCookie = getCookieHeader(loginResponse);
    expect(loginCookie).toContain('HttpOnly');

    const logoutResponse = await logoutAdminSession(
      makeRequest('/admin-api/auth/session', {
        cookie: loginCookie,
      }),
    );
    expect(logoutResponse.status).toBe(200);
    expect(getCookieHeader(logoutResponse)).toContain('Max-Age=0');
  });

  it('requires an admin session before starting or polling OAuth credentials', async () => {
    await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const startResponse = await startCodeBuddyAuth(
      makeRequest('/codebuddy/auth/start'),
    );
    const pollResponse = await pollCodeBuddyAuth(
      'state-1',
      makeRequest('/codebuddy/auth/poll'),
    );

    expect(startResponse.status).toBe(401);
    expect(pollResponse.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when admin auth storage is unreadable', async () => {
    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(path.join(tempDataDir, 'admin-auth.json'), '{');

    expect(
      (await getAdminSessionErrorResponse(makeRequest('/admin-api/settings')))
        ?.status,
    ).toBe(503);
  });

  it('covers passkey auth guard branches and rp id resolution through config storage', async () => {
    const noPasskeyResponse = await beginAdminPasskeyAuthentication(
      makeRequest('/admin-api/auth/passkeys/authentication/options'),
    );
    expect(noPasskeyResponse.status).toBe(400);

    const setupResponse = await setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    const setupCookie = getCookieHeader(setupResponse);

    await writeStorageJson('config', 'runtime', {
      CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'admin.example.com',
    });

    const registrationResponse = await beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options', {
        cookie: setupCookie,
        host: 'console.example.com',
        protocol: 'https',
      }),
      '',
    );
    expect(registrationResponse.status).toBe(200);
    const registrationPayload = (await registrationResponse.json()) as {
      name: string;
      options: { rp: { id: string; name: string } };
    };
    expect(registrationPayload.name).toBe('Passkey 1');
    expect(registrationPayload.options.rp.id).toBe('admin.example.com');

    const unauthenticatedRegistration = await beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options'),
      'Named key',
    );
    expect(unauthenticatedRegistration.status).toBe(401);
  });

  it('covers file storage read write list delete and metadata helpers', async () => {
    expect(getStorageBackendMeta()).toEqual({
      backend: 'file',
      encryptionEnabled: false,
      schema: null,
    });

    await ensureStorageReady();
    await writeStorageJson('config', 'runtime', {
      CODEBUDDY_API_ENDPOINT: 'https://example.com',
    });
    expect(
      await readStorageJson<{ CODEBUDDY_API_ENDPOINT: string }>(
        'config',
        'runtime',
      ),
    ).toEqual({
      CODEBUDDY_API_ENDPOINT: 'https://example.com',
    });

    const configPath = path.join(tempDataDir, 'runtime.json');
    expect(await readStorageJsonResult('config', 'runtime')).toEqual({
      error: null,
      exists: true,
      value: {
        CODEBUDDY_API_ENDPOINT: 'https://example.com',
      },
    });

    fs.writeFileSync(configPath, '{');
    expect(await readStorageJsonResult('config', 'runtime')).toMatchObject({
      error: expect.any(String),
      exists: true,
      value: null,
    });

    await writeStorageJson('credentials', 'cred-a.json', {
      bearer_token: 'token-a',
    });
    await writeStorageJson('credentials', 'manager_state.json', {
      selectedCredentialFilename: 'cred-a.json',
    });
    await writeStorageJson('credentials', 'cred-b.json', {
      access_token: 'token-b',
    });

    const listedCredentials =
      await listStorageJson<Record<string, string>>('credentials');
    expect(listedCredentials.map((entry) => entry.key)).toEqual([
      'cred-a.json',
      'cred-b.json',
    ]);

    await deleteStorageJson('credentials', 'cred-a.json');
    expect(
      await readStorageJson<Record<string, string>>(
        'credentials',
        'cred-a.json',
      ),
    ).toBeNull();
  });
});
