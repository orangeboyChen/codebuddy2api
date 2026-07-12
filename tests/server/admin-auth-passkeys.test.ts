import fs from 'node:fs';
import path from 'node:path';

const mockGenerateAuthenticationOptions = vi.fn();
const mockGenerateRegistrationOptions = vi.fn();
const mockVerifyAuthenticationResponse = vi.fn();
const mockVerifyRegistrationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mockGenerateAuthenticationOptions,
  generateRegistrationOptions: mockGenerateRegistrationOptions,
  verifyAuthenticationResponse: mockVerifyAuthenticationResponse,
  verifyRegistrationResponse: mockVerifyRegistrationResponse,
}));

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-admin-auth-passkeys');

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

describe('admin auth passkeys', () => {
  beforeEach(() => {
    cleanupTempState();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_CONFIG_PATH = '.codebuddy_data/runtime.json';
    delete process.env.CODEBUDDY_ADMIN_PASSKEY_RP_ID;
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('registers a passkey, signs in with it, and keeps secure cookies on https', async () => {
    const storage = await import('@/lib/server/storage');
    const adminAuth = await import('@/lib/server/admin/session');

    mockGenerateRegistrationOptions.mockResolvedValue({
      challenge: 'registration-challenge',
    });
    mockVerifyRegistrationResponse.mockResolvedValue({
      registrationInfo: {
        credential: {
          counter: 1,
          id: 'passkey-1',
          publicKey: new Uint8Array([1, 2, 3]),
          transports: ['internal'],
        },
        credentialBackedUp: true,
        credentialDeviceType: 'singleDevice',
      },
      verified: true,
    });
    mockGenerateAuthenticationOptions.mockResolvedValue({
      allowCredentials: [],
      challenge: 'authentication-challenge',
    });
    mockVerifyAuthenticationResponse.mockResolvedValue({
      authenticationInfo: {
        newCounter: 5,
      },
      verified: true,
    });

    const preseededRegistrationResponse =
      await adminAuth.beginAdminPasskeyRegistration(
        makeRequest('/admin-api/auth/passkeys/registration/options', {
          host: 'admin.example.com',
          protocol: 'https',
        }),
        'Untrusted key',
      );
    expect(preseededRegistrationResponse.status).toBe(401);

    const setupResponse = await adminAuth.setupAdminPassword(
      makeRequest('/admin-api/auth/setup', {
        host: 'admin.example.com',
        protocol: 'https',
      }),
      'correct horse battery staple',
    );
    const cookie = getCookieHeader(setupResponse);

    const registrationOptionsResponse =
      await adminAuth.beginAdminPasskeyRegistration(
        makeRequest('/admin-api/auth/passkeys/registration/options', {
          cookie,
          host: 'admin.example.com',
          protocol: 'https',
        }),
        'Primary key',
      );
    expect(registrationOptionsResponse.status).toBe(200);

    const registerResponse = await adminAuth.finishAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/verify', {
        cookie,
        host: 'admin.example.com',
        protocol: 'https',
      }),
      {
        id: 'passkey-1',
        rawId: 'passkey-1',
        response: {},
        type: 'public-key',
      },
      'Primary key',
    );
    expect(registerResponse.status).toBe(200);
    expect(await adminAuth.listAdminPasskeys()).toEqual([
      expect.objectContaining({
        counter: 1,
        id: 'passkey-1',
        name: 'Primary key',
      }),
    ]);

    const authOptionsResponse = await adminAuth.beginAdminPasskeyAuthentication(
      makeRequest('/admin-api/auth/passkeys/authentication/options', {
        host: 'admin.example.com',
        protocol: 'https',
      }),
    );
    expect(authOptionsResponse.status).toBe(200);

    const authResponse = await adminAuth.finishAdminPasskeyAuthentication(
      makeRequest('/admin-api/auth/passkeys/authentication/verify', {
        host: 'admin.example.com',
        protocol: 'https',
      }),
      {
        id: 'passkey-1',
        rawId: 'passkey-1',
        response: {},
        type: 'public-key',
      },
    );
    expect(authResponse.status).toBe(200);
    expect(getCookieHeader(authResponse)).toContain('Secure');
    expect(await adminAuth.listAdminPasskeys()).toEqual([
      expect.objectContaining({
        counter: 5,
        id: 'passkey-1',
      }),
    ]);

    const summary = await adminAuth.getAdminSessionSummary(
      makeRequest('/admin-api/auth/session', {
        cookie: getCookieHeader(authResponse),
        host: 'admin.example.com',
        protocol: 'https',
      }),
    );
    expect(summary).toEqual({
      accountConfigured: true,
      authEnabled: true,
      authenticated: true,
      passkeyCount: 1,
      passwordConfigured: true,
      username: 'admin',
    });

    await storage.deleteStorageJson('admin-auth', 'state');
  });

  it('returns validation errors for expired or rejected passkey flows', async () => {
    const adminAuth = await import('@/lib/server/admin/session');

    mockGenerateRegistrationOptions.mockResolvedValue({
      challenge: 'registration-challenge',
    });

    const setupResponse = await adminAuth.setupAdminPassword(
      makeRequest('/admin-api/auth/setup'),
      'correct horse battery staple',
    );
    const cookie = getCookieHeader(setupResponse);

    const expiredRegistration = await adminAuth.finishAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/verify', {
        cookie,
      }),
      {
        id: 'passkey-unknown',
      },
      'Primary key',
    );
    expect(expiredRegistration.status).toBe(400);

    await adminAuth.beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options', {
        cookie,
      }),
      'Primary key',
    );

    mockVerifyRegistrationResponse.mockRejectedValueOnce(
      new Error('registration rejected'),
    );
    const rejectedRegistration = await adminAuth.finishAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/verify', {
        cookie,
      }),
      {
        id: 'passkey-1',
      },
      'Primary key',
    );
    expect(rejectedRegistration.status).toBe(400);

    await adminAuth.beginAdminPasskeyRegistration(
      makeRequest('/admin-api/auth/passkeys/registration/options', {
        cookie,
      }),
      'Primary key',
    );
    mockVerifyRegistrationResponse.mockResolvedValueOnce({
      registrationInfo: null,
      verified: false,
    });
    const unverifiableRegistration =
      await adminAuth.finishAdminPasskeyRegistration(
        makeRequest('/admin-api/auth/passkeys/registration/verify', {
          cookie,
        }),
        {
          id: 'passkey-1',
        },
        'Primary key',
      );
    expect(unverifiableRegistration.status).toBe(400);

    expect(
      await adminAuth.finishAdminPasskeyAuthentication(
        makeRequest('/admin-api/auth/passkeys/authentication/verify'),
        {
          id: 'unknown-passkey',
        },
      ),
    ).toMatchObject({
      status: 400,
    });
  });
});
