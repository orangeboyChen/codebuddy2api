import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

import {
  DEVICE_CLIENT_ID,
  DEVICE_GRANT_TYPE,
} from '../../lib/server/admin/device-client';

/**
 * A desktop app signing in to a deployment: the whole of it.
 *
 * The app's half is asked here over HTTP exactly as the app asks it — a code to
 * wait with, a code to show — and the user's half is typed into the page in a
 * real browser, because that page is the whole point of the exercise: a passkey
 * and a saved password work on the deployment's address and would not work in
 * the app's window at `127.0.0.1`. What is left out is the dialog the desktop
 * shows the code in, which no test can click.
 */
const USERNAME = 'admin';
const PASSWORD = 'the-device-e2e-password';

interface Grant {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
}

/** The app's first move: two codes, neither of which is a credential. */
const askForCode = async (request: APIRequestContext): Promise<Grant> => {
  const response = await request.post('/admin-api/oauth/device', {
    data: { client_id: DEVICE_CLIENT_ID },
  });

  expect(response.ok()).toBe(true);

  const grant = (await response.json()) as Grant;

  expect(grant.device_code).not.toBe('');
  expect(grant.user_code).not.toBe('');

  return grant;
};

/** The app's second move, asked again until the user has approved. */
const askForToken = (
  request: APIRequestContext,
  deviceCode: string,
): ReturnType<APIRequestContext['post']> =>
  request.post('/admin-api/oauth/token', {
    data: {
      client_id: DEVICE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    },
  });

/**
 * The user's half, in a browser: signing in, and being brought back to the code.
 *
 * The console asks them to sign in first — approving a device is saying it is
 * theirs, which only the admin can say — and returns them to the page with the
 * code still in it afterwards.
 */
const openDevicePage = async (page: Page, userCode: string): Promise<void> => {
  await page.goto(`/device?user_code=${encodeURIComponent(userCode)}`);

  await expect(page).toHaveURL(/\/login/);

  // The form is a client component: filled before it hydrates, the value lands
  // in the DOM and not in React, and the submit button — which waits for both
  // fields — never enables. Filled again until it does, which is what a user in
  // front of the same window would do.
  const submit = page.locator('button[type="submit"]');

  await expect
    .poll(
      async () => {
        await page.locator('#admin-username').fill(USERNAME);
        await page.locator('#admin-password').fill(PASSWORD);

        return await submit.isEnabled();
      },
      { intervals: [1_000], timeout: 60_000 },
    )
    .toBe(true);

  await submit.click();

  await expect(page).toHaveURL(/\/device/);
  await expect(page.getByText('Approve a device')).toBeVisible({
    timeout: 30_000,
  });
};

/**
 * Pressed until the page says the thing it was waiting for.
 *
 * A press that lands before the page has hydrated goes nowhere at all, and once
 * the page has answered there is no longer a button to press — so each round
 * asks whether there is one.
 */
const pressUntil = async (page: Page, text: string): Promise<void> => {
  await expect
    .poll(
      async () => {
        const approve = page.getByRole('button', { name: 'Approve' });

        if ((await approve.count()) > 0) {
          await approve.click({ timeout: 5_000 }).catch(() => undefined);
        }

        return await page.getByText(text).isVisible();
      },
      { intervals: [1_000], timeout: 60_000 },
    )
    .toBe(true);
};

/** The code the app showed, approved by the user it was shown to. */
const approveInBrowser = async (
  page: Page,
  userCode: string,
): Promise<void> => {
  await openDevicePage(page, userCode);
  await pressUntil(page, 'Device approved');
};

/** The token the app ended up with, once the user has approved. */
const waitForToken = async (
  request: APIRequestContext,
  deviceCode: string,
): Promise<string> => {
  let token = '';

  await expect
    .poll(
      async () => {
        const response = await askForToken(request, deviceCode);

        if (!response.ok()) {
          return '';
        }

        token =
          ((await response.json()) as { access_token?: string }).access_token ??
          '';

        return token;
      },
      { intervals: [500], timeout: 30_000 },
    )
    .not.toBe('');

  return token;
};

test.describe('A desktop app signing in to a deployment', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: 'codebuddy2api-locale',
        value: 'en-US',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
  });

  test.beforeAll(async ({ request }) => {
    // A console somebody signs in to, which is the only kind a device can join.
    const response = await request.post('/admin-api/auth/setup', {
      data: { password: PASSWORD, username: USERNAME },
    });

    expect(response.ok()).toBe(true);
  });

  test('is signed in by the code it showed the user', async ({
    page,
    request,
  }) => {
    const grant = await askForCode(request);

    // Where the app sends the user is this console's own page, with the code
    // already in it.
    expect(grant.verification_uri_complete).toContain('/device?user_code=');
    expect(grant.verification_uri_complete).toContain(grant.user_code);

    // Asked before anybody has approved: not yet, rather than a token.
    const pending = await askForToken(request, grant.device_code);

    expect(pending.status()).toBe(400);
    expect(await pending.json()).toEqual({ error: 'authorization_pending' });

    await approveInBrowser(page, grant.user_code);

    const token = await waitForToken(request, grant.device_code);

    // The token is a credential: it is what the app sends with everything it
    // asks the deployment for, and the deployment answers as the admin.
    const settings = await request.get('/admin-api/settings', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(settings.ok()).toBe(true);

    // Spent on the app that asked for it: a second exchange off one approval is
    // answered with a no.
    const again = await askForToken(request, grant.device_code);

    expect(again.ok()).toBe(false);
  });

  test('is nobody without a code the user approved', async ({ request }) => {
    await askForCode(request);

    // A device code nobody was ever given: answered the same as one that ran
    // out, because telling them apart would only say which codes were handed
    // out.
    const invented = await askForToken(request, 'not-a-device-code');

    const payload = (await invented.json()) as { error?: string };

    expect(invented.ok()).toBe(false);
    expect(payload.error).toMatch(/^(expired_token|invalid_grant)$/);
  });

  test('approves no code this console never issued', async ({ page }) => {
    await openDevicePage(page, 'NOPE-NOPE');

    await pressUntil(
      page,
      'That code is not one this console is waiting for, or it has run out.',
    );
  });

  test('is forgotten when the app signs out', async ({ page, request }) => {
    const grant = await askForCode(request);

    await approveInBrowser(page, grant.user_code);

    const token = await waitForToken(request, grant.device_code);
    const bearer = { authorization: `Bearer ${token}` };

    expect(
      (await request.get('/admin-api/settings', { headers: bearer })).ok(),
    ).toBe(true);

    // Signing out is this machine forgetting the token, and the deployment
    // being asked to forget it: what it carries should not still open the door.
    const revoked = await request.delete('/admin-api/oauth/token', {
      headers: bearer,
    });

    expect(revoked.ok()).toBe(true);
    expect(
      (await request.get('/admin-api/settings', { headers: bearer })).status(),
    ).toBe(401);
  });
});
