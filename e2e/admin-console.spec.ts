import { expect, test } from '@playwright/test';

const filename = `admin-console-e2e-${process.pid}.json`;
const json = (body: unknown) => ({
  data: body,
  headers: { 'Content-Type': 'application/json' },
});

test.describe('Admin console essentials', () => {
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

  test.afterEach(async ({ request }) => {
    const credentialsResponse = await request.get('/admin-api/credentials');
    const credentials = (await credentialsResponse.json()) as {
      credentials?: Array<{ filename?: string; index?: number }>;
    };
    const credential = credentials.credentials?.find(
      (item) => item.filename === filename,
    );

    if (typeof credential?.index === 'number') {
      await request.post('/admin-api/credentials/delete', {
        data: { index: credential.index },
      });
    }
  });

  test('reports a healthy storage backend', async ({ request }) => {
    const response = await request.get('/health');

    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual(
      expect.objectContaining({ service: 'codebuddy2api', status: 'healthy' }),
    );
  });

  test('validates preferences and persists locale/theme cookies', async ({
    request,
  }) => {
    const invalidLocale = await request.post('/admin-api/preferences', {
      ...json({ localePreference: 'xx-INVALID' }),
    });
    expect(invalidLocale.status()).toBe(400);

    const response = await request.post('/admin-api/preferences', {
      ...json({
        localePreference: 'zh-CN',
        resolvedTheme: 'dark',
        theme: 'dark',
      }),
    });
    expect(response.ok()).toBe(true);
    expect(response.headers()['set-cookie']).toContain(
      'codebuddy2api-locale=zh-CN',
    );
    expect(response.headers()['set-cookie']).toContain(
      'codebuddy2api-theme=dark',
    );
  });

  test('reads and updates runtime settings through the settings API', async ({
    request,
  }) => {
    const before = await request.get('/admin-api/settings');
    expect(before.ok()).toBe(true);
    expect((await before.json()).settings).toBeDefined();

    const updated = await request.post('/admin-api/settings', {
      ...json({ settings: { debug_enabled: true } }),
    });
    expect(updated.ok()).toBe(true);
    expect((await updated.json()).settings).toBeDefined();
  });

  test('supports usage range validation and debug settings lifecycle', async ({
    request,
  }) => {
    const invalidUsage = await request.get('/admin-api/usage?range=invalid');
    expect(invalidUsage.status()).toBe(400);

    const usage = await request.get('/admin-api/usage?range=1h');
    expect(usage.ok()).toBe(true);
    expect((await usage.json()).range).toBe('1h');

    const debugSettings = await request.post('/admin-api/debug', {
      ...json({ autoRefreshSeconds: 0, enabled: true, maxEntries: 10 }),
    });
    expect(debugSettings.ok()).toBe(true);
    expect(await debugSettings.json()).toEqual(
      expect.objectContaining({ enabled: true, maxEntries: 10 }),
    );

    const debugList = await request.get('/admin-api/debug');
    expect(debugList.ok()).toBe(true);
    expect((await debugList.json()).items).toEqual([]);
    const cleared = await request.delete('/admin-api/debug');
    expect(cleared.ok()).toBe(true);
  });

  test('returns stable empty states from stats and credential model APIs', async ({
    request,
  }) => {
    const stats = await request.get('/admin-api/stats');
    expect(stats.ok()).toBe(true);
    expect(await stats.json()).toEqual(
      expect.objectContaining({
        credential_usage: expect.any(Object),
        model_usage: expect.any(Object),
      }),
    );

    const models = await request.get('/admin-api/credentials/models');
    expect(models.ok()).toBe(true);
    expect(await models.json()).toEqual({ models: {} });

    const unavailable = await request.post('/admin-api/credentials/models', {
      ...json({ filename: 'missing.json' }),
    });
    expect(unavailable.status()).toBe(404);
  });

  test('rejects malformed credential and selection payloads', async ({
    request,
  }) => {
    const malformedCredential = await request.post('/admin-api/credentials', {
      ...json({ filename: '../escape.json', bearer_token: 'token' }),
    });
    expect(malformedCredential.status()).toBe(400);

    const malformedDelete = await request.post(
      '/admin-api/credentials/delete',
      {
        ...json({ index: '0' }),
      },
    );
    expect(malformedDelete.status()).toBe(400);

    const malformedSelect = await request.post(
      '/admin-api/credentials/select',
      {
        ...json({ index: 1.5 }),
      },
    );
    expect(malformedSelect.status()).toBe(400);
  });

  test('creates, edits, and deletes a credential from the console', async ({
    page,
  }) => {
    const createResponse = await page.request.post('/admin-api/credentials', {
      data: {
        bearer_token: 'e2e-bearer-token',
        filename,
        user_id: 'e2e@example.test',
      },
    });
    expect(createResponse.ok()).toBe(true);
    await page.goto('/credentials');
    const credentialCard = page.locator(
      `[data-credential-filename="${filename}"]`,
    );
    await expect(credentialCard).toBeVisible();
    const editButton = credentialCard.getByRole('button', { name: 'Edit' });
    const saveButton = credentialCard.getByRole('button', {
      name: 'Save',
      exact: true,
    });
    await expect
      .poll(
        async () => {
          if (await saveButton.isVisible()) return true;
          await editButton.click();
          return saveButton.isVisible();
        },
        { intervals: [100, 250, 500], timeout: 10_000 },
      )
      .toBe(true);
    await saveButton.click();
    await expect(page.getByText('Credential saved:')).toBeVisible();

    await credentialCard.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Credential deleted.')).toBeVisible();
  });

  test('covers credential selection, current state, model persistence, and rotation', async ({
    request,
  }) => {
    const created = await request.post('/admin-api/credentials', {
      ...json({
        bearer_token: 'e2e-api-token',
        filename,
        user_id: 'api@example.test',
      }),
    });
    expect(created.ok()).toBe(true);
    const listed = await request.get('/admin-api/credentials');
    const credential = (
      (await listed.json()).credentials as Array<{ index: number }>
    ).find((item) => typeof item.index === 'number');
    expect(credential).toBeDefined();

    const selected = await request.post('/admin-api/credentials/select', {
      ...json({ index: credential?.index }),
    });
    expect(selected.ok()).toBe(true);
    expect((await request.get('/admin-api/credentials/current')).ok()).toBe(
      true,
    );

    const models = await request.put('/admin-api/credentials/models', {
      ...json({ filename, models: 'glm-e2e\n glm-e2e-2' }),
    });
    expect(models.ok()).toBe(true);
    expect((await models.json()).models[`${filename}`].models).toEqual([
      { id: 'glm-e2e' },
      { id: 'glm-e2e-2' },
    ]);

    const rotation = await request.post(
      '/admin-api/credentials/toggle-rotation',
    );
    expect(rotation.ok()).toBe(true);
    expect((await rotation.json()).auto_rotation_enabled).toBe(true);
  });

  test('returns safe errors for unauthorized proxy requests', async ({
    request,
  }) => {
    const models = await request.get('/v1/models');
    expect([200, 401, 403]).toContain(models.status());
    const completion = await request.post('/v1/chat/completions', {
      ...json({
        model: 'glm-e2e',
        messages: [{ content: 'hello', role: 'user' }],
      }),
    });
    expect([400, 401, 403, 500, 502]).toContain(completion.status());
  });

  test('renders API Test controls with no eligible credentials', async ({
    page,
  }) => {
    await page.goto('/api-test');

    await expect(page.getByRole('button', { name: 'API Test' })).toBeVisible();
    await expect(page.getByLabel('Credential')).toBeVisible();
    await expect(page.getByLabel('Model')).toBeVisible();
    await expect(page.getByLabel('Test message')).toHaveValue(
      'Hello, what is 2+2?',
    );
    await expect(page.getByRole('button', { name: 'Send test' })).toBeVisible();
    await expect(
      page.getByText('Click "Send test" to view the API response...'),
    ).toBeVisible();
  });

  test('loads every admin console page and keeps navigation in sync', async ({
    page,
  }) => {
    const pages = [
      ['/dashboard', 'Dashboard'],
      ['/usage', 'Usage'],
      ['/credentials', 'Credentials'],
      ['/account-status', 'Account Status'],
      ['/api-test', 'API Test'],
      ['/debug', 'Debug'],
      ['/settings', 'Settings'],
    ] as const;

    for (const [route, tab] of pages) {
      await page.goto(route);
      await expect(
        page.getByRole('button', { name: tab, exact: true }),
      ).toBeVisible();
      await expect(page.locator('main')).toBeVisible();
    }
  });

  test('redirects the root route to dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole('button', { name: 'Dashboard', exact: true }),
    ).toBeVisible();
  });
});
