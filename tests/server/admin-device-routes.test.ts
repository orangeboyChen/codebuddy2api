import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three endpoints a device sign-in is made of, asked the way the desktop app
 * asks them: a code to show, an approval that needs the admin's own session, and
 * a token the device is given once the user has said yes in a browser.
 */

const mocks = vi.hoisted(() => {
  const docs = new Map<string, unknown>();
  const readError: { value: string | null } = { value: null };

  return {
    docs,
    readError,
    readStorageJsonResult: vi.fn(async (namespace: string, key: string) => ({
      error: readError.value,
      exists: docs.has(`${namespace}/${key}`),
      value: docs.get(`${namespace}/${key}`) ?? null,
    })),
    writeStorageJson: vi.fn(
      async (namespace: string, key: string, value: unknown) => {
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
  beginAdminPasskeyRegistration,
  deleteAdminPasskey,
  disableAdminAuthentication,
  isAdminBrowserSessionAuthenticated,
  isAdminSessionAuthenticated,
  loginWithAdminPassword,
  setupAdminPassword,
} = await import('@/lib/server/admin/session');
const deviceRoute = await import('@/app/admin-api/oauth/device/route');
const tokenRoute = await import('@/app/admin-api/oauth/token/route');
const approveRoute = await import('@/app/admin-api/oauth/device/approve/route');
const { DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } =
  await import('@/lib/server/admin/device-client');

const ORIGIN = 'https://admin.example.com';
const PASSWORD = 'a-password-long-enough';

const request = (path: string, init?: RequestInit): Request =>
  new Request(`${ORIGIN}${path}`, init);

const jsonPost = (path: string, body: unknown, init?: RequestInit): Request =>
  request(path, {
    ...init,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init?.headers },
    method: 'POST',
  });

/** A console somebody signs in to, which is the only kind a device can join. */
const configureAdmin = async (): Promise<void> => {
  const response = await setupAdminPassword(
    request('/admin-api/auth/password'),
    'admin',
    PASSWORD,
  );

  expect(response.status).toBeLessThan(400);
};

/** The cookie of a session the admin signed in with, in a browser. */
const adminCookie = async (): Promise<string> => {
  const response = await loginWithAdminPassword(
    request('/admin-api/auth/login'),
    'admin',
    PASSWORD,
  );
  const cookie = response.headers.get('set-cookie') ?? '';

  return cookie.split(';')[0] ?? '';
};

const askForCode = async (): Promise<{
  device_code: string;
  user_code: string;
}> =>
  deviceRoute.POST(request('/admin-api/oauth/device')).then((r) => r.json());

describe('the code a device asks for', () => {
  beforeEach(() => {
    mocks.docs.clear();
    mocks.readError.value = null;
  });

  it('has nothing to approve a device into on a console nobody signs in to', async () => {
    const response = await deviceRoute.POST(request('/admin-api/oauth/device'));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'admin_auth_not_configured' },
    });
  });

  it('says so rather than failing when the console cannot read its own state', async () => {
    mocks.readError.value = 'storage is unreadable';

    const response = await deviceRoute.POST(request('/admin-api/oauth/device'));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'admin_auth_storage_unavailable' },
    });
  });

  it('answers with two codes on a console that does ask for a sign-in', async () => {
    await configureAdmin();

    const response = await deviceRoute.POST(request('/admin-api/oauth/device'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verification_uri: `${ORIGIN}/device`,
    });
  });
});

describe('the token a device is given', () => {
  beforeEach(async () => {
    mocks.docs.clear();
    mocks.readError.value = null;
    await configureAdmin();
  });

  it('is not given to a request that is not JSON', async () => {
    const response = await tokenRoute.POST(
      request('/admin-api/oauth/token', { method: 'POST' }),
    );

    expect(response.status).toBe(400);
  });

  it('is not given for a grant this console does not exchange', async () => {
    const response = await tokenRoute.POST(
      jsonPost('/admin-api/oauth/token', {
        device_code: 'code',
        grant_type: 'authorization_code',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unsupported_grant_type',
    });
  });

  it('is not given to a client that names another client', async () => {
    const response = await tokenRoute.POST(
      jsonPost('/admin-api/oauth/token', {
        client_id: 'someone-else',
        device_code: 'code',
        grant_type: DEVICE_GRANT_TYPE,
      }),
    );

    expect(await response.json()).toEqual({ error: 'invalid_client' });
  });

  it('is told to ask again while the user has not approved', async () => {
    const { device_code: deviceCode } = await askForCode();
    const response = await tokenRoute.POST(
      jsonPost('/admin-api/oauth/token', {
        client_id: DEVICE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'authorization_pending' });
  });

  it('is handed over once the user has approved in a browser', async () => {
    const { device_code: deviceCode, user_code: userCode } = await askForCode();
    const approved = await approveRoute.POST(
      jsonPost(
        '/admin-api/oauth/device/approve',
        { user_code: userCode },
        {
          headers: { cookie: await adminCookie() },
        },
      ),
    );

    expect(approved.status).toBe(200);

    const response = await tokenRoute.POST(
      jsonPost('/admin-api/oauth/token', {
        client_id: DEVICE_CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: 'Bearer' });
  });

  it('is forgotten when the device signs out', async () => {
    const response = await tokenRoute.DELETE(
      request('/admin-api/oauth/token', {
        headers: { authorization: 'Bearer gone' },
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });
});

describe('approving a code', () => {
  beforeEach(async () => {
    mocks.docs.clear();
    mocks.readError.value = null;
    await configureAdmin();
  });

  it('is only asked of somebody this console knows is the admin', async () => {
    const response = await approveRoute.POST(
      jsonPost('/admin-api/oauth/device/approve', { user_code: 'AAAA-BBBB' }),
    );

    expect(response.status).toBe(401);
  });

  it('does not approve a code this console is not waiting for', async () => {
    await askForCode();

    const response = await approveRoute.POST(
      jsonPost(
        '/admin-api/oauth/device/approve',
        { user_code: 'ZZZZ-ZZZZ' },
        { headers: { cookie: await adminCookie() } },
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { message: 'That code is not one this console is waiting for' },
    });
  });

  it('is not approved from a request with no code in it', async () => {
    const response = await approveRoute.POST(
      jsonPost(
        '/admin-api/oauth/device/approve',
        {},
        {
          headers: { cookie: await adminCookie() },
        },
      ),
    );

    expect(response.status).toBe(404);
  });
});

/**
 * A token the app is holding, which is what an approval is supposed to need a
 * browser for: the app reads this console with its token, and that is all the
 * token is for.
 */
const signedInBearer = async (): Promise<string> => {
  const { device_code: deviceCode, user_code: userCode } = await askForCode();

  const approved = await approveRoute.POST(
    jsonPost(
      '/admin-api/oauth/device/approve',
      { user_code: userCode },
      { headers: { cookie: await adminCookie() } },
    ),
  );

  expect(approved.status).toBe(200);

  const exchanged = await tokenRoute.POST(
    jsonPost('/admin-api/oauth/token', {
      client_id: DEVICE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    }),
  );

  expect(exchanged.status).toBe(200);

  const { access_token: token } = (await exchanged.json()) as {
    access_token: string;
  };

  return `Bearer ${token}`;
};

describe('approving a code with a token rather than a browser', () => {
  beforeEach(async () => {
    mocks.docs.clear();
    mocks.readError.value = null;
    await configureAdmin();
  });

  it('is refused, because a token that could approve could replace itself', async () => {
    const authorization = await signedInBearer();
    const { user_code: userCode } = await askForCode();

    const response = await approveRoute.POST(
      jsonPost(
        '/admin-api/oauth/device/approve',
        { user_code: userCode },
        { headers: { authorization } },
      ),
    );

    expect(response.status).toBe(401);
  });

  it('is still the admin everywhere the token is what the app reads with', async () => {
    const authorization = await signedInBearer();
    const bearer = request('/admin-api/settings', {
      headers: { authorization },
    });

    // The refusal above is not the token being worthless: it still opens the
    // console's data, and it is only the handing out of credentials it is not
    // asked about.
    await expect(isAdminSessionAuthenticated(bearer)).resolves.toBe(true);
    await expect(isAdminBrowserSessionAuthenticated(bearer)).resolves.toBe(
      false,
    );
  });

  it('is nobody in particular on a console that asks for no sign-in', async () => {
    vi.stubEnv('CODEBUDDY_DESKTOP', '1');

    const bearer = request('/admin-api/settings', {
      headers: { authorization: 'Bearer nothing' },
    });

    // This machine's own console is not one anybody signs in to, so there is no
    // session to be the admin of: both gates are open, and neither a token nor
    // a cookie is what opened them.
    await expect(isAdminSessionAuthenticated(bearer)).resolves.toBe(true);
    await expect(isAdminBrowserSessionAuthenticated(bearer)).resolves.toBe(
      true,
    );

    vi.unstubAllEnvs();
  });
});

/**
 * What a device token is not asked about: how the admin signs in.
 *
 * The token was approved so the app could read and write this console's data as
 * the admin. It was not approved to hand out credentials — a passkey outlives
 * the token, is not evicted by the cap on tokens and is not taken back by
 * signing out — nor to take the door off its hinges, which is what turning
 * authentication off does: every gate answers "nothing to ask" afterwards, and
 * the console is open to anybody who can reach it.
 */
describe('the credentials a device token is not asked about', () => {
  beforeEach(async () => {
    mocks.docs.clear();
    mocks.readError.value = null;
    await configureAdmin();
  });

  it('is not who adds a way to sign in', async () => {
    const response = await beginAdminPasskeyRegistration(
      request('/admin-api/auth/passkeys/registration/options', {
        headers: { authorization: await signedInBearer() },
        method: 'POST',
      }),
      'A key',
    );

    expect(response.status).toBe(401);
  });

  it('is not who takes one away', async () => {
    const response = await deleteAdminPasskey(
      request('/admin-api/auth/passkeys/passkey-1', {
        headers: { authorization: await signedInBearer() },
        method: 'DELETE',
      }),
      'passkey-1',
    );

    // Refused rather than not found: the answer comes before the console goes
    // looking for the key, so it says nothing about which keys there are.
    expect(response.status).toBe(401);
  });

  it('is not who takes the door off its hinges', async () => {
    const response = await disableAdminAuthentication(
      request('/admin-api/auth/password', {
        headers: { authorization: await signedInBearer() },
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(401);

    // Still a console somebody has to sign in to: what was refused is not a
    // request that merely failed.
    await expect(
      isAdminSessionAuthenticated(request('/admin-api/settings')),
    ).resolves.toBe(false);
  });

  it('is the admin in a browser who decides', async () => {
    // The refusal above is not these endpoints being closed to everybody: with
    // the cookie of the session the admin signed in with, both are answered.
    const cookie = await adminCookie();

    expect(
      (
        await beginAdminPasskeyRegistration(
          request('/admin-api/auth/passkeys/registration/options', {
            headers: { cookie },
            method: 'POST',
          }),
          'A key',
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await disableAdminAuthentication(
          request('/admin-api/auth/password', {
            headers: { cookie },
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(200);
  });
});
