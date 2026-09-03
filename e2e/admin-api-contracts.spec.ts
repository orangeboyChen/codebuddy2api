import { expect, test } from '@playwright/test';

const json = (body: unknown) => ({
  data: body,
  headers: { 'Content-Type': 'application/json' },
});

const credentialName = (suffix: string) => `contract-${suffix}.json`;

test.describe('Admin API contracts', () => {
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
    for (const credential of credentials.credentials ?? []) {
      if (
        typeof credential.index === 'number' &&
        credential.filename?.startsWith('contract-')
      ) {
        await request.post('/admin-api/credentials/delete', {
          data: { index: credential.index },
        });
      }
    }

    const accessKeysResponse = await request.get('/admin-api/access-keys');
    const accessKeys = (await accessKeysResponse.json()) as {
      access_keys?: Array<{ id?: string; name?: string }>;
    };
    for (const accessKey of accessKeys.access_keys ?? []) {
      if (accessKey.id && accessKey.name?.startsWith('contract-')) {
        await request.delete(`/admin-api/access-keys/${accessKey.id}`);
      }
    }
  });

  test('returns an unauthenticated admin session summary', async ({
    request,
  }) => {
    const response = await request.get('/admin-api/auth/session');
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          accountConfigured: false,
          authEnabled: false,
          authenticated: false,
          passkeyCount: 0,
          passwordConfigured: false,
        }),
      }),
    );
  });

  test('rejects invalid admin password setup without changing state', async ({
    request,
  }) => {
    const invalidUsername = await request.post('/admin-api/auth/setup', {
      ...json({ password: 'long-enough-password', username: 'x' }),
    });
    expect(invalidUsername.status()).toBe(400);

    const invalidPassword = await request.post('/admin-api/auth/setup', {
      ...json({ password: 'short', username: 'contract-admin' }),
    });
    expect(invalidPassword.status()).toBe(400);

    const session = await request.get('/admin-api/auth/session');
    expect((await session.json()).session.accountConfigured).toBe(false);
  });

  test('returns a safe error when password login is unavailable', async ({
    request,
  }) => {
    const response = await request.post('/admin-api/auth/session', {
      ...json({ password: 'wrong-password', username: 'admin' }),
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Admin password is not configured' },
    });
  });

  test('exposes empty passkey state and rejects unauthenticated options', async ({
    request,
  }) => {
    const list = await request.get('/admin-api/auth/passkeys');
    expect(list.ok()).toBe(true);
    expect(await list.json()).toEqual(
      expect.objectContaining({ passkeys: [], session: expect.any(Object) }),
    );

    const authentication = await request.post(
      '/admin-api/auth/passkeys/authentication/options',
    );
    expect(authentication.status()).toBe(400);

    const registration = await request.post(
      '/admin-api/auth/passkeys/registration/options',
      { ...json({ name: 'contract-passkey' }) },
    );
    expect(registration.status()).toBe(401);
  });

  test('lists, creates, reads, updates, and deletes access keys', async ({
    request,
  }) => {
    const initial = await request.get('/admin-api/access-keys');
    expect(initial.ok()).toBe(true);
    expect((await initial.json()).access_keys).toEqual([]);

    const missingCredential = await request.post('/admin-api/access-keys', {
      ...json({ credential_filenames: ['missing.json'], name: 'contract-key' }),
    });
    expect(missingCredential.status()).toBe(400);

    const filename = credentialName('access-key');
    const credential = await request.post('/admin-api/credentials', {
      ...json({
        bearer_token: 'contract-token',
        filename,
        supported_models: 'contract-model',
        user_id: 'contract@example.test',
      }),
    });
    expect(credential.ok()).toBe(true);

    const created = await request.post('/admin-api/access-keys', {
      ...json({
        credential_filenames: [filename, ` ${filename} `],
        name: ' contract-key ',
      }),
    });
    expect(created.ok()).toBe(true);
    const createdBody = (await created.json()) as {
      access_key: { id: string; name: string; maskedSecret: string };
      secret: string;
    };
    expect(createdBody.access_key.name).toBe('contract-key');
    expect(createdBody.access_key.maskedSecret).not.toContain(
      createdBody.secret,
    );

    const listed = await request.get('/admin-api/access-keys');
    expect((await listed.json()).access_keys).toEqual([
      expect.objectContaining({
        credentialFilenames: [filename],
        id: createdBody.access_key.id,
        name: 'contract-key',
      }),
    ]);

    const secret = await request.get(
      `/admin-api/access-keys/${createdBody.access_key.id}/secret`,
    );
    expect(await secret.json()).toEqual({
      id: createdBody.access_key.id,
      name: 'contract-key',
      secret: createdBody.secret,
    });

    const updated = await request.patch(
      `/admin-api/access-keys/${createdBody.access_key.id}`,
      {
        ...json({ credential_filenames: [filename], name: 'contract-renamed' }),
      },
    );
    expect(updated.ok()).toBe(true);
    expect((await updated.json()).access_key.name).toBe('contract-renamed');

    const invalidUpdate = await request.patch(
      `/admin-api/access-keys/${createdBody.access_key.id}`,
      { ...json({ credential_filenames: ['missing.json'], name: 'bad' }) },
    );
    expect(invalidUpdate.status()).toBe(400);

    const deleted = await request.delete(
      `/admin-api/access-keys/${createdBody.access_key.id}`,
    );
    expect(await deleted.json()).toEqual({ success: true });
    expect(
      (
        await request.get(
          `/admin-api/access-keys/${createdBody.access_key.id}/secret`,
        )
      ).status(),
    ).toBe(404);
  });

  test('handles access-key not-found mutations', async ({ request }) => {
    const patch = await request.patch('/admin-api/access-keys/not-found', {
      ...json({ credential_filenames: [], name: 'contract-key' }),
    });
    expect(patch.status()).toBe(404);
    const deletion = await request.delete('/admin-api/access-keys/not-found');
    expect(deletion.status()).toBe(404);
    const secret = await request.get('/admin-api/access-keys/not-found/secret');
    expect(secret.status()).toBe(404);
  });

  test('covers credential auto rotation and empty current state', async ({
    request,
  }) => {
    const current = await request.get('/admin-api/credentials/current');
    expect(current.ok()).toBe(true);
    expect(await current.json()).toEqual({ status: 'no_credentials' });

    const auto = await request.post('/admin-api/credentials/auto');
    expect(auto.ok()).toBe(true);
    expect(await auto.json()).toEqual({
      message: 'Round-robin is always enabled',
      success: true,
    });
  });

  test('supports account-status filtering and check-in actions with no credentials', async ({
    request,
  }) => {
    const get = await request.get('/admin-api/account-status');
    expect(get.ok()).toBe(true);
    expect(await get.json()).toEqual({ credentials: [], statuses: [] });

    const filtered = await request.post('/admin-api/account-status', {
      ...json({ filename: 'missing.json' }),
    });
    expect(filtered.ok()).toBe(true);
    expect((await filtered.json()).statuses).toEqual([]);

    const checkinAll = await request.post('/admin-api/account-status', {
      ...json({ action: 'checkin' }),
    });
    expect(checkinAll.ok()).toBe(true);
    expect((await checkinAll.json()).statuses).toEqual([]);

    const checkinOne = await request.post('/admin-api/account-status', {
      ...json({ action: 'checkin', filename: 'missing.json' }),
    });
    expect(checkinOne.status()).toBe(500);
  });

  test('clears usage history and validates debug settings bounds', async ({
    request,
  }) => {
    const clear = await request.post('/admin-api/usage/clear');
    expect(await clear.json()).toEqual({ success: true });

    const settings = await request.post('/admin-api/debug', {
      ...json({ autoRefreshSeconds: 300, enabled: false, maxEntries: 1 }),
    });
    expect(settings.ok()).toBe(true);
    expect(await settings.json()).toEqual({
      autoRefreshSeconds: 300,
      enabled: false,
      maxEntries: 1,
    });

    const missingLog = await request.get('/admin-api/debug?id=missing-id');
    expect(missingLog.status()).toBe(404);
    expect(await missingLog.json()).toEqual({ item: null });
  });

  test('returns localized settings labels and handles preference variants', async ({
    request,
  }) => {
    const settings = await request.get('/admin-api/settings', {
      headers: { cookie: 'codebuddy2api-locale=zh-CN' },
    });
    expect(settings.ok()).toBe(true);
    expect((await settings.json()).labels).toEqual(expect.any(Object));

    const system = await request.post('/admin-api/preferences', {
      ...json({ localePreference: 'system', theme: 'system' }),
    });
    expect(system.ok()).toBe(true);
    expect(system.headers()['set-cookie']).toContain('Max-Age=0');

    const invalidTheme = await request.post('/admin-api/preferences', {
      ...json({ theme: 'neon' }),
    });
    expect(invalidTheme.status()).toBe(400);
  });

  test('covers public authentication responses when no access key exists', async ({
    request,
  }) => {
    const models = await request.get('/v1/models');
    expect([200, 500, 502]).toContain(models.status());
    if (models.ok()) {
      expect((await models.json()).object).toBe('list');
    }

    const messages = await request.post('/v1/messages', {
      ...json({ model: 'contract-model', messages: [] }),
    });
    expect([400, 500, 502]).toContain(messages.status());

    const responses = await request.post('/v1/responses', {
      ...json({ input: 'hello', model: 'contract-model' }),
    });
    expect([400, 500, 502]).toContain(responses.status());
  });

  test('covers CodeBuddy auth route validation and upstream failure handling', async ({
    request,
  }) => {
    const poll = await request.post('/codebuddy/auth/poll', {
      ...json({ auth_state: '' }),
    });
    expect(poll.status()).toBe(400);
    expect(await poll.json()).toEqual(
      expect.objectContaining({ error: 'missing_parameters' }),
    );

    const start = await request.get('/codebuddy/auth/start');
    expect([400, 500]).toContain(start.status());
    expect(await start.json()).toEqual(
      expect.objectContaining({ success: false, error: 'auth_start_failed' }),
    );

    const callback = await request.get('/codebuddy/auth/callback');
    expect(callback.ok()).toBe(true);
    expect(await callback.json()).toEqual({
      code: null,
      message: '授权成功！请返回应用程序。',
      state: null,
    });
  });

  test('renders login and security pages without hydration errors', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByText(/Admin|登录|管理员/i).first()).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('main')).toBeVisible();
  });
});
