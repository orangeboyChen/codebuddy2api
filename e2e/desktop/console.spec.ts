import { expect, test } from '@playwright/test';

/**
 * The console the desktop app opens, without the app: desktop mode is an
 * environment variable, so the server this run talks to is the console as the
 * app serves it — no sign-in, its own gateway settings, and no separate server
 * to name a version for.
 */
test.describe('Desktop console', () => {
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

  test('opens the dashboard without asking anyone to sign in', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    await expect(page).not.toHaveURL(/login/);
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });

  test('offers the gateway settings and no console password', async ({
    page,
  }) => {
    await page.goto('/settings');

    // Waited out rather than assumed: this is a dev server, and the first
    // render of a route it has not compiled yet takes seconds on a runner that
    // is slower than a laptop.
    await expect(page.getByText('Local port', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Console security')).toHaveCount(0);
  });

  test('saves the port the desktop app should use', async ({ request }) => {
    const response = await request.post('/admin-api/desktop', {
      data: { port: 8123 },
    });

    expect(response.ok()).toBe(true);

    const payload = (await response.json()) as {
      desktop?: boolean;
      preferredPort?: number;
      restarting?: boolean;
    };

    expect(payload.desktop).toBe(true);
    expect(payload.preferredPort).toBe(8123);
  });

  test('names the build it is serving, and no longer has an About page', async ({
    page,
    request,
  }) => {
    // What the menu bar item asks a backend of its own: this console is the
    // app's own gateway, so there is no second build to name.
    const response = await request.get('/admin-api/version');

    expect(response.ok()).toBe(true);
    expect(((await response.json()) as { version?: string }).version).toMatch(
      /^\d+\.\d+\.\d+/,
    );

    // The versions live in the menu bar now, not in a tab.
    await expect(page.getByRole('button', { name: 'About' })).toHaveCount(0);
    expect((await page.goto('/about'))?.status()).toBe(404);
  });
});
