import http from 'node:http';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in of a desktop app into a deployment, asked the way it happens.
 *
 * The two halves are covered apart from each other elsewhere: the endpoints on
 * the deployment's side, and the client that reads what they answer. What is
 * worth covering together is the seam between them — that the code the client
 * shows is the one the console's own page approves, that the address it sends
 * the user to is the console's, and that what the client then waits for is the
 * one thing the console hands out. Neither half can say any of that alone.
 *
 * Nothing here waits in real time: the waiting is the app's, and it is injected.
 */

const mocks = vi.hoisted(() => {
  const docs = new Map<string, unknown>();

  return {
    docs,
    readStorageJsonResult: vi.fn(async (namespace: string, key: string) => ({
      error: null,
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

const { setupAdminPassword, loginWithAdminPassword } =
  await import('@/lib/server/admin/session');
const { isDeviceTokenAuthorized } = await import('@/lib/server/admin/device');
const { DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } =
  await import('@/lib/server/admin/device-client');
const { requestDeviceAuthorization, startDeviceRedirectListener } =
  await import('@/lib/server/electron/device-auth');
const deviceRoute = await import('@/app/admin-api/oauth/device/route');
const approveRoute = await import('@/app/admin-api/oauth/device/approve/route');
const tokenRoute = await import('@/app/admin-api/oauth/token/route');

const ORIGIN = 'https://admin.example.com';
const PASSWORD = 'a-password-long-enough';

const request = (path: string, init?: RequestInit): Request =>
  new Request(`${ORIGIN}${path}`, init);

/**
 * The browser, coming home: a GET on the address the app is listening on, which
 * is what the deployment's own page does once the user has approved.
 */
const browseTo = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on('end', resolve);
    });

    request.on('error', reject);
  });

const jsonPost = (path: string, body: unknown, init?: RequestInit): Request =>
  request(path, {
    ...init,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...init?.headers },
    method: 'POST',
  });

/**
 * The wire between the app and the deployment.
 *
 * A URL and a body in, the route's own answer out — there is no socket, and no
 * cookie the client did not send, because a device has none.
 */
const statuses: number[] = [];

const fetchImpl = async (
  url: string,
  init: { body: string; headers: Record<string, string>; method: string },
): Promise<Response> => {
  const { pathname } = new URL(url);

  if (pathname === '/admin-api/oauth/device') {
    return await deviceRoute.POST(
      new Request(url, {
        body: init.body,
        headers: init.headers,
        method: init.method,
      }),
    );
  }

  if (pathname === '/admin-api/oauth/token') {
    const response = await tokenRoute.POST(
      new Request(url, {
        body: init.body,
        headers: init.headers,
        method: init.method,
      }),
    );

    statuses.push(response.status);

    return response;
  }

  throw new Error(`no endpoint at ${pathname}`);
};

/** A console somebody signs in to, which is the only kind a device can join. */
const configureAdmin = async (): Promise<void> => {
  const response = await setupAdminPassword(
    request('/admin-api/auth/password'),
    'admin',
    PASSWORD,
  );

  expect(response.status).toBeLessThan(400);
};

/** The cookie of the session the admin is approving from, in a browser. */
const adminCookie = async (): Promise<string> => {
  const response = await loginWithAdminPassword(
    request('/admin-api/auth/login'),
    'admin',
    PASSWORD,
  );

  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
};

/**
 * The browser half: the page the app sent the user to, where the code shown in
 * the dialog is typed in and the approval is made.
 */
const approveInBrowser = async (userCode: string): Promise<Response> =>
  await approveRoute.POST(
    jsonPost(
      '/admin-api/oauth/device/approve',
      { user_code: userCode },
      { headers: { cookie: await adminCookie() } },
    ),
  );

beforeEach(() => {
  mocks.docs.clear();
  statuses.length = 0;
});

describe('a desktop app signing in to a deployment', () => {
  it('is signed in by the code it showed the user', async () => {
    await configureAdmin();

    const listener = await startDeviceRedirectListener({ state: 'a-state' });

    const requested = await requestDeviceAuthorization({
      baseUrl: `${ORIGIN}/`,
      fetchImpl,
      redirectUri: listener.redirectUri,
    });

    expect(requested.kind).toBe('granted');

    if (requested.kind !== 'granted') {
      return;
    }

    const { grant } = requested;

    // Where the user is sent is this console's own page, with the code already
    // filled in: a passkey works on the address it was saved for, which is why
    // the app cannot ask for the password in its own window.
    expect(grant.verificationUriComplete).toBe(
      `${ORIGIN}/device?user_code=${encodeURIComponent(grant.userCode)}`,
    );

    // A code this console never issued is not one it approves.
    expect((await approveInBrowser('XXXX-YYYY')).status).toBe(404);

    /*
      The user approves in the browser, and what the browser is given to carry
      home is this machine's own address with the token in it — which is the
      whole reason the app is listening instead of asking again.
    */
    const approved = await approveInBrowser(grant.userCode);

    expect(approved.ok).toBe(true);

    const { redirect } = (await approved.json()) as { redirect?: string };

    expect(redirect?.startsWith(listener.redirectUri)).toBe(true);

    const answered = listener.wait(30_000);

    await browseTo(String(redirect));

    const token = await answered;
    listener.close();

    expect(token?.accessToken ?? '').not.toBe('');

    // The token is a credential, not a receipt: it is what the app forwards
    // with everything it asks the deployment for.
    await expect(
      isDeviceTokenAuthorized(
        new Request(`${ORIGIN}/admin-api/usage`, {
          headers: { authorization: `Bearer ${token?.accessToken}` },
        }),
      ),
    ).resolves.toBe(true);
  });

  it('spends the code on the app that asked for it, and no other', async () => {
    await configureAdmin();

    const listener = await startDeviceRedirectListener({ state: 'a-state' });

    const requested = await requestDeviceAuthorization({
      baseUrl: ORIGIN,
      fetchImpl,
      redirectUri: listener.redirectUri,
    });

    if (requested.kind !== 'granted') {
      throw new Error('expected a grant');
    }

    const { grant } = requested;

    const approved = await approveInBrowser(grant.userCode);

    expect(approved.ok).toBe(true);

    const answered = listener.wait(30_000);
    const { redirect } = (await approved.json()) as { redirect?: string };

    await browseTo(String(redirect));

    expect((await answered)?.accessToken ?? '').not.toBe('');
    listener.close();

    // Asked for again with the code already spent — a second window, or the
    // same one that lost its answer — the deployment says no rather than
    // minting a second token off one approval.
    const again = await tokenRoute.POST(
      jsonPost('/admin-api/oauth/token', {
        client_id: DEVICE_CLIENT_ID,
        device_code: grant.deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      }),
    );

    expect(again.ok).toBe(false);
  });

  it('has nothing to sign in to on a console nobody signs in to', async () => {
    const requested = await requestDeviceAuthorization({
      baseUrl: ORIGIN,
      fetchImpl,
    });

    // A console with no administrator account has nothing for a device to be
    // signed in to — which is worth saying rather than reporting as a failure.
    expect(requested).toEqual({ kind: 'notConfigured' });
    expect(statuses).toEqual([]);
  });
});
