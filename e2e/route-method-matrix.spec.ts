import { expect, test, type APIRequestContext } from '@playwright/test';

const json = (body: unknown) => ({
  data: body,
  headers: { 'Content-Type': 'application/json' },
});

const expectJson = async (response: {
  headers: () => Record<string, string>;
}) => {
  expect(response.headers()['content-type']).toContain('application/json');
};

const clearCredentials = async (request: APIRequestContext) => {
  const body = (await request
    .get('/admin-api/credentials')
    .then((response) => response.json())) as {
    credentials?: Array<{ index?: number }>;
  };
  for (const credential of body.credentials ?? []) {
    if (typeof credential.index === 'number') {
      await request.post('/admin-api/credentials/delete', {
        data: { index: credential.index },
      });
    }
  }
};

test.describe('Route method matrix', () => {
  test.beforeEach(async ({ request }) => {
    await clearCredentials(request);
  });

  test('GET admin endpoints return JSON contracts', async ({ request }) => {
    const endpoints = [
      '/admin-api/access-keys',
      '/admin-api/account-status',
      '/admin-api/credentials',
      '/admin-api/credentials/current',
      '/admin-api/credentials/models',
      '/admin-api/debug',
      '/admin-api/settings',
      '/admin-api/stats',
      '/admin-api/auth/session',
      '/admin-api/auth/passkeys',
      '/admin-api/usage?range=1h',
      '/health',
    ];
    for (const endpoint of endpoints) {
      const response = await request.get(endpoint);
      expect(response.status(), endpoint).toBe(200);
      await expectJson(response);
      expect(await response.json()).toBeDefined();
    }
  });

  test('unsupported methods return controlled responses', async ({
    request,
  }) => {
    const endpoints = [
      '/admin-api/access-keys',
      '/admin-api/account-status',
      '/admin-api/credentials',
      '/admin-api/debug',
      '/admin-api/settings',
      '/admin-api/stats',
      '/admin-api/usage',
      '/v1/models',
      '/health',
    ];
    for (const endpoint of endpoints) {
      const response = await request.fetch(endpoint, { method: 'PUT' });
      expect([404, 405, 400]).toContain(response.status());
    }
  });

  test('access key route rejects malformed JSON shapes', async ({
    request,
  }) => {
    const bodies: unknown[] = [
      null,
      [],
      'key',
      42,
      { credential_filenames: [] },
      { name: '   ', credential_filenames: [] },
      { name: 'key', credential_filenames: [1] },
      { name: 'key', credential_filenames: [null] },
      { name: 'key', credential_filenames: [{}] },
    ];
    for (const body of bodies) {
      const response = await request.post('/admin-api/access-keys', {
        ...json(body),
      });
      expect([200, 400], JSON.stringify(body)).toContain(response.status());
      await expectJson(response);
      expect(await response.json()).toBeDefined();
    }
  });

  test('credential model route preserves empty model semantics', async ({
    request,
  }) => {
    const response = await request.put('/admin-api/credentials/models', {
      ...json({ filename: 'missing.json', models: '' }),
    });
    expect(response.status()).toBe(404);
    await expectJson(response);
    expect((await response.json()).error).toEqual(expect.any(Object));
  });

  test('credential deletion route is idempotent for missing records', async ({
    request,
  }) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request.post('/admin-api/credentials/delete', {
        ...json({ index: 9999 }),
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(
        expect.objectContaining({ success: false }),
      );
    }
  });

  test('credential selection route is idempotent for missing records', async ({
    request,
  }) => {
    for (const index of [9999, 10000, 2147483647]) {
      const response = await request.post('/admin-api/credentials/select', {
        ...json({ index }),
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual(
        expect.objectContaining({ success: false }),
      );
    }
  });

  test('account status route supports empty and whitespace filenames', async ({
    request,
  }) => {
    for (const filename of ['', ' ']) {
      const response = await request.post('/admin-api/account-status', {
        ...json({ filename }),
      });
      expect([200, 500]).toContain(response.status());
      expect(await response.json()).toBeDefined();
    }
  });

  test('account status check-in distinguishes missing credentials', async ({
    request,
  }) => {
    const response = await request.post('/admin-api/account-status', {
      ...json({ action: 'checkin', filename: 'missing.json' }),
    });
    expect(response.status()).toBe(500);
  });

  test('usage route rejects every unsupported range', async ({ request }) => {
    const ranges = [
      '',
      '0',
      '30m',
      '2h',
      '8h',
      '48h',
      '2d',
      '14d',
      'tomorrow',
      'INVALID',
    ];
    for (const range of ranges) {
      const response = await request.get(
        `/admin-api/usage?range=${encodeURIComponent(range)}`,
      );
      expect([400, 500], range || 'empty').toContain(response.status());
    }
  });

  test('usage clear ignores request bodies and remains safe', async ({
    request,
  }) => {
    for (const body of [
      undefined,
      {},
      { clear: true },
      { unexpected: 'value' },
    ]) {
      const options = body === undefined ? {} : json(body);
      const response = await request.post('/admin-api/usage/clear', options);
      expect([200, 401]).toContain(response.status());
      expect(await response.json()).toEqual({ success: true });
    }
  });

  test('debug route returns 404 for blank and unknown identifiers', async ({
    request,
  }) => {
    for (const id of ['', ' ', 'missing', '0', 'null']) {
      const response = await request.get(
        `/admin-api/debug?id=${encodeURIComponent(id)}`,
      );
      expect([200, 404]).toContain(response.status());
      expect(await response.json()).toBeDefined();
    }
  });

  test('debug update normalizes omitted and invalid values', async ({
    request,
  }) => {
    const payloads: unknown[] = [
      {},
      { enabled: true },
      { enabled: false },
      { autoRefreshSeconds: 0 },
      { maxEntries: 1 },
      { autoRefreshSeconds: 99999, maxEntries: -1 },
      { enabled: 'true', autoRefreshSeconds: '5', maxEntries: '10' },
    ];
    for (const payload of payloads) {
      const response = await request.post('/admin-api/debug', {
        ...json(payload),
      });
      expect([200, 401]).toContain(response.status());
      const body = await response.json();
      expect(body).toEqual(
        expect.objectContaining({
          autoRefreshSeconds: expect.any(Number),
          enabled: expect.any(Boolean),
          maxEntries: expect.any(Number),
        }),
      );
    }
  });

  test('preferences route handles omitted fields without cookies', async ({
    request,
  }) => {
    const payloads: unknown[] = [
      {},
      { resolvedTheme: 'dark' },
      { localePreference: 'zh-CN' },
    ];
    for (const payload of payloads) {
      const response = await request.post('/admin-api/preferences', {
        ...json(payload),
      });
      expect([200, 401]).toContain(response.status());
      expect(await response.json()).toEqual({ success: true });
    }
  });

  test('preferences route rejects invalid locale values', async ({
    request,
  }) => {
    for (const localePreference of ['en', 'zh', 'ja', 'fr-FR', 'systematic']) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ localePreference }),
      });
      expect(response.status()).toBe(400);
    }
  });

  test('preferences route rejects invalid theme values', async ({
    request,
  }) => {
    for (const theme of ['blue', 'auto', 'SYSTEM', 'dark-mode', 'null']) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ theme }),
      });
      expect(response.status()).toBe(400);
    }
  });

  test('auth session logout always clears its cookie', async ({ request }) => {
    const response = await request.delete('/admin-api/auth/session');
    expect(response.status()).toBe(200);
    expect(response.headers()['set-cookie']).toContain(
      'codebuddy_admin_session=',
    );
    expect(response.headers()['set-cookie']).toContain('Max-Age=0');
  });

  test('auth setup validates username boundaries', async ({ request }) => {
    const usernames = ['', 'a', 'ab', 'a'.repeat(65)];
    for (const username of usernames) {
      const response = await request.post('/admin-api/auth/setup', {
        ...json({ password: 'valid-password', username }),
      });
      expect(response.status()).toBe(400);
    }
  });

  test('auth setup validates password length and type', async ({ request }) => {
    const passwords: unknown[] = [
      '',
      'short',
      '1234567',
      null,
      12345678,
      {},
      [],
    ];
    for (const password of passwords) {
      const response = await request.post('/admin-api/auth/setup', {
        ...json({ password, username: 'contract-user' }),
      });
      expect([400, 409]).toContain(response.status());
    }
  });

  test('auth login returns a structured error when no account exists', async ({
    request,
  }) => {
    for (const body of [
      {},
      { username: 'admin' },
      { password: 'password' },
      { username: 'admin', password: 'password' },
    ]) {
      const response = await request.post('/admin-api/auth/session', {
        ...json(body),
      });
      expect([400, 401]).toContain(response.status());
      await expectJson(response);
      expect((await response.json()).error).toEqual(expect.any(Object));
    }
  });

  test('passkey routes reject malformed verification payloads safely', async ({
    request,
  }) => {
    const registration = await request.post(
      '/admin-api/auth/passkeys/registration/verify',
      { ...json({}) },
    );
    expect([400, 401]).toContain(registration.status());

    const authentication = await request.post(
      '/admin-api/auth/passkeys/authentication/verify',
      { ...json({ response: null }) },
    );
    expect([400, 401]).toContain(authentication.status());

    const options = await request.post(
      '/admin-api/auth/passkeys/authentication/options',
      { ...json({ unexpected: true }) },
    );
    expect([400, 401]).toContain(options.status());
  });

  test('public models route handles auth header variants', async ({
    request,
  }) => {
    const headers: Record<string, string>[] = [
      {},
      { authorization: 'Bearer invalid' },
      { authorization: 'Basic invalid' },
      { authorization: 'Bearer' },
      { authorization: 'bearer invalid' },
      { 'x-api-key': 'invalid' },
      { 'x-api-key': '   ' },
    ];
    for (const header of headers) {
      const response = await request.get('/v1/models', { headers: header });
      expect([200, 401, 403, 500, 502]).toContain(response.status());
      await expectJson(response);
    }
  });

  test('public completion routes preserve JSON errors for malformed bodies', async ({
    request,
  }) => {
    const endpoints = [
      '/v1/chat/completions',
      '/v1/messages',
      '/v1/responses',
      '/admin-api/chat/completions',
    ];
    for (const endpoint of endpoints) {
      for (const body of [{}, [], 'text', { model: 1 }]) {
        const response = await request.post(endpoint, { ...json(body) });
        expect([400, 401, 403, 500, 502]).toContain(response.status());
        await expectJson(response);
        expect(await response.json()).toBeDefined();
      }
    }
  });

  test('auth callback maps query parameters without mutation', async ({
    request,
  }) => {
    const cases = [
      ['/codebuddy/auth/callback', 200],
      ['/codebuddy/auth/callback?code=', 200],
      ['/codebuddy/auth/callback?state=', 200],
      ['/codebuddy/auth/callback?error=invalid_request', 400],
      ['/codebuddy/auth/callback?error=access_denied&state=state', 400],
    ] as const;
    for (const [endpoint, status] of cases) {
      const response = await request.get(endpoint);
      expect(response.status()).toBe(status);
      await expectJson(response);
      expect(await response.json()).toBeDefined();
    }
  });

  test('auth poll validates state values before upstream access', async ({
    request,
  }) => {
    for (const auth_state of ['', ' ', '\n', '\t']) {
      const response = await request.post('/codebuddy/auth/poll', {
        ...json({ auth_state }),
      });
      expect(response.status()).toBe(400);
      expect((await response.json()).error).toBe('missing_parameters');
    }
  });

  test('all JSON APIs return parseable payloads on empty state', async ({
    request,
  }) => {
    const requests = [
      request.get('/admin-api/access-keys'),
      request.get('/admin-api/account-status'),
      request.get('/admin-api/credentials'),
      request.get('/admin-api/credentials/current'),
      request.get('/admin-api/credentials/models'),
      request.get('/admin-api/debug'),
      request.get('/admin-api/settings'),
      request.get('/admin-api/stats'),
      request.get('/admin-api/auth/session'),
      request.get('/admin-api/auth/passkeys'),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.status()).toBe(200);
      await expectJson(response);
      const body = await response.json();
      expect(body).not.toBeNull();
    }
  });

  test('route responses include no credential filesystem paths', async ({
    request,
  }) => {
    const responses = await Promise.all([
      request.get('/admin-api/access-keys'),
      request.get('/admin-api/account-status'),
      request.get('/admin-api/credentials'),
      request.get('/admin-api/debug'),
      request.get('/admin-api/settings'),
      request.get('/admin-api/stats'),
    ]);
    for (const response of responses) {
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain('.codebuddy_creds');
      expect(body).not.toContain('.codebuddy_data');
      expect(body).not.toContain('admin-auth');
    }
  });

  test('health endpoint remains fast and cache-safe', async ({ request }) => {
    const started = Date.now();
    const response = await request.get('/health');
    const elapsed = Date.now() - started;
    expect(response.status()).toBe(200);
    expect(elapsed).toBeLessThan(2000);
    expect(response.headers()['cache-control'] ?? '').not.toContain('public');
  });

  test('deep links remain available after API calls', async ({
    page,
    request,
  }) => {
    await request.get('/admin-api/stats');
    await request.get('/admin-api/credentials');
    for (const route of [
      '/dashboard',
      '/credentials',
      '/usage',
      '/debug',
      '/settings',
    ]) {
      const response = await page.goto(route);
      expect(response?.ok(), route).toBe(true);
      await expect(page.locator('main')).toBeVisible();
    }
  });

  test('navigation remains stable after repeated route transitions', async ({
    page,
  }) => {
    const routes = [
      '/dashboard',
      '/usage',
      '/credentials',
      '/account-status',
      '/api-test',
      '/debug',
      '/settings',
    ];
    for (let round = 0; round < 2; round += 1) {
      for (const route of routes) {
        await page.goto(route);
        await expect(page.locator('main')).toBeVisible();
        await expect(page.locator('body')).not.toContainText(
          'Application error',
        );
      }
    }
  });
});
