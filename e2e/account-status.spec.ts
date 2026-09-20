import { expect, test } from '@playwright/test';

test.describe('Account Status tab', () => {
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

  test('navigates to the tab and shows the empty state', async ({ page }) => {
    await page.goto('/account-status');

    await expect(
      page.getByRole('button', { name: 'Account Status' }),
    ).toBeVisible();
    await expect(
      page.getByText('No credentials', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh all' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check in all' }),
    ).toBeVisible();
  });

  test('keeps the account status layout usable on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/account-status');

    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await expect(
      page.getByText('No credentials', { exact: true }),
    ).toBeVisible();
  });

  test('renders account status from SSR without a client refresh request', async ({
    page,
  }) => {
    const accountStatusRequests: string[] = [];
    page.on('request', (request) => {
      if (
        request.url().includes('/admin-api/account-status') &&
        request.method() === 'POST'
      ) {
        accountStatusRequests.push(request.url());
      }
    });

    await page.goto('/account-status');

    await expect(
      page.getByRole('button', { name: 'Refresh all' }),
    ).toBeVisible();
    expect(accountStatusRequests).toHaveLength(0);
  });

  test('copies a configured model from an account status card', async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'http://127.0.0.1:8001',
    });
    await page.addInitScript(() => {
      let clipboardText = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText: async () => clipboardText,
          writeText: async (value: string) => {
            clipboardText = value;
          },
        },
      });
    });
    const filename = `account-status-copy-${process.pid}.json`;
    const createResponse = await page.request.post('/admin-api/credentials', {
      data: {
        bearer_token: 'e2e-token',
        filename,
        supported_models: 'e2e-copy-model',
        user_id: 'e2e@example.test',
      },
    });
    expect(createResponse.ok()).toBe(true);
    try {
      await page.goto('/account-status');
      const modelTag = page.locator('[data-model-id="e2e-copy-model"]');
      await expect(modelTag).toBeVisible();
      // The tag is server-rendered, so it is visible before React attaches the
      // click handler that copies. On a slow runner the click would otherwise
      // land on inert markup and the clipboard would never fill.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const tag = document
              .querySelector('[data-model-id]')
              ?.closest('.ant-tag');
            if (!tag) return false;
            return Object.keys(tag).some((key) => key.startsWith('__react'));
          }),
        )
        .toBe(true);
      await modelTag.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe('e2e-copy-model');
    } finally {
      const credentialsResponse = await page.request.get(
        '/admin-api/credentials',
      );
      const credentials = (await credentialsResponse.json()) as {
        credentials?: Array<{ filename?: string }>;
      };
      const index = credentials.credentials?.findIndex(
        (credential) => credential.filename === filename,
      );
      if (index !== undefined && index >= 0) {
        await page.request.post('/admin-api/credentials/delete', {
          data: { index },
        });
      }
    }
  });

  test('wraps a long model id instead of overflowing a phone viewport', async ({
    page,
  }) => {
    // Upstream ids run to dozens of characters with no space to break on, and
    // the tag they sit in is `white-space: nowrap` by default.
    const longId = `glm-5.3-enterprise-preview-v2-final-${'0123456789'.repeat(4)}`;
    const filename = `account-status-long-id-${process.pid}.json`;
    const createResponse = await page.request.post('/admin-api/credentials', {
      data: {
        bearer_token: 'e2e-token',
        filename,
        supported_models: longId,
        user_id: 'e2e@example.test',
      },
    });
    expect(createResponse.ok()).toBe(true);
    try {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto('/account-status');
      await expect(page.locator(`[data-model-id="${longId}"]`)).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(0);
    } finally {
      const credentialsResponse = await page.request.get(
        '/admin-api/credentials',
      );
      const credentials = (await credentialsResponse.json()) as {
        credentials?: Array<{ filename?: string }>;
      };
      const index = credentials.credentials?.findIndex(
        (credential) => credential.filename === filename,
      );
      if (index !== undefined && index >= 0) {
        await page.request.post('/admin-api/credentials/delete', {
          data: { index },
        });
      }
    }
  });
});
