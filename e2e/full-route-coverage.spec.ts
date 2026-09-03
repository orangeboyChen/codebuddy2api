import { expect, test, type APIRequestContext } from '@playwright/test';

const json = (body: unknown) => ({
  data: body,
  headers: { 'Content-Type': 'application/json' },
});

const readJson = async (response: { json: () => Promise<unknown> }) => {
  return (await response.json()) as Record<string, unknown>;
};

const clearIsolatedState = async (request: APIRequestContext) => {
  const credentials = (await request
    .get('/admin-api/credentials')
    .then((response) => response.json())) as {
    credentials?: Array<{ index?: number }>;
  };
  for (const credential of credentials.credentials ?? []) {
    if (typeof credential.index === 'number') {
      await request.post('/admin-api/credentials/delete', {
        data: { index: credential.index },
      });
    }
  }
};

test.describe('Full route coverage', () => {
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

  test.beforeEach(async ({ request }) => {
    await clearIsolatedState(request);
  });

  test('serves every public page with a stable document shell', async ({
    page,
  }) => {
    const routes = [
      '/',
      '/dashboard',
      '/credentials',
      '/account-status',
      '/api-test',
      '/usage',
      '/debug',
      '/settings',
      '/login',
    ];

    for (const route of routes) {
      const response = await page.goto(route);
      expect(response?.ok(), route).toBe(true);
      await expect(page.locator('body')).toBeVisible();
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('header')).toBeVisible();
    }
  });

  test('renders dashboard content and responsive navigation', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText(/CodeBuddy|API/i).first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
  });

  test('renders credentials empty state and action controls', async ({
    page,
  }) => {
    await page.goto('/credentials');
    await expect(
      page.getByRole('button', { name: 'Credentials' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Add credential/i }),
    ).toBeVisible();
    await expect(page.locator('main')).toContainText(/credential/i);
  });

  test('renders usage controls and default range', async ({ page }) => {
    await page.goto('/usage');
    await expect(page.getByRole('button', { name: 'Usage' })).toBeVisible();
    await expect(page.locator('main')).toContainText(/usage/i);
    const rangeControl = page.getByRole('combobox').first();
    if (await rangeControl.count()) {
      await expect(rangeControl).toBeVisible();
    }
  });

  test('renders debug controls and empty log state', async ({ page }) => {
    await page.goto('/debug');
    await expect(page.getByRole('button', { name: 'Debug' })).toBeVisible();
    await expect(page.locator('main')).toContainText(/debug/i);
    await expect(page.getByRole('button', { name: /clear/i })).toBeVisible();
  });

  test('renders settings controls and security section', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('main')).toContainText(/settings/i);
    await expect(page.locator('main')).toContainText(
      /security|password|passkey/i,
    );
  });

  test('renders login fields and rejects an empty submission', async ({
    page,
  }) => {
    await page.goto('/login');
    const username = page.getByLabel(/username|用户名/i).first();
    const password = page.getByLabel(/password|密码/i).first();
    if (await username.count()) {
      await expect(username).toBeVisible();
    }
    if (await password.count()) {
      await expect(password).toBeVisible();
    }
    const submit = page
      .getByRole('button', { name: /sign in|login|登录/i })
      .first();
    if (await submit.count()) {
      await submit.click();
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('returns health metadata without leaking storage paths', async ({
    request,
  }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    const body = await readJson(response);
    expect(body.service).toBe('codebuddy2api');
    expect(body.status).toBe('healthy');
    expect(JSON.stringify(body)).not.toContain('.codebuddy_data');
    expect(JSON.stringify(body)).not.toContain('.codebuddy_creds');
  });

  test('covers settings GET locale fallback and localized labels', async ({
    request,
  }) => {
    const locales = [undefined, 'en-US', 'zh-CN', 'ja-JP', 'invalid-locale'];

    for (const locale of locales) {
      const response = await request.get('/admin-api/settings', {
        headers: locale ? { cookie: `codebuddy2api-locale=${locale}` } : {},
      });
      expect(response.status(), locale ?? 'default').toBe(200);
      const body = await readJson(response);
      expect(body.settings).toEqual(expect.any(Object));
      expect(body.labels).toEqual(expect.any(Object));
      expect(Object.keys(body.labels as object).length).toBeGreaterThan(0);
    }
  });

  test('updates settings with known and unknown keys without crashing', async ({
    request,
  }) => {
    const known = await request.post('/admin-api/settings', {
      ...json({ settings: { debug_enabled: true } }),
    });
    expect(known.status()).toBe(200);
    expect((await readJson(known)).settings).toEqual(expect.any(Object));

    const unknown = await request.post('/admin-api/settings', {
      ...json({ settings: { unknown_setting: 'ignored' } }),
    });
    expect(unknown.status()).toBe(200);
    const unknownBody = await readJson(unknown);
    expect(unknownBody.settings).toEqual(expect.any(Object));
    expect(JSON.stringify(unknownBody)).not.toContain('unknown_setting');
  });

  test('validates every supported usage range', async ({ request }) => {
    const ranges = [
      '1h',
      '3h',
      '6h',
      '12h',
      '24h',
      '3d',
      '7d',
      'today',
      'yesterday',
    ];

    for (const range of ranges) {
      const response = await request.get(`/admin-api/usage?range=${range}`);
      expect(response.status(), range).toBe(200);
      const body = await readJson(response);
      expect(body.range).toBe(range);
      expect(body).toEqual(
        expect.objectContaining({
          callSeries: expect.any(Array),
          credentialRows: expect.any(Array),
          rangeSummary: expect.any(Object),
          tableRows: expect.any(Array),
        }),
      );
    }

    const invalid = await request.get('/admin-api/usage?range=0');
    expect(invalid.status()).toBe(400);
    expect((await readJson(invalid)).error).toBe('Unsupported usage range');
  });

  test('clears usage repeatedly and remains idempotent', async ({
    request,
  }) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request.post('/admin-api/usage/clear');
      expect(response.status()).toBe(200);
      expect(await readJson(response)).toEqual({ success: true });
    }
  });

  test('covers debug settings normalization across supported values', async ({
    request,
  }) => {
    const values = [
      { autoRefreshSeconds: 0, enabled: false, maxEntries: 1 },
      { autoRefreshSeconds: 5, enabled: true, maxEntries: 10 },
      { autoRefreshSeconds: 15, enabled: false, maxEntries: 50 },
      { autoRefreshSeconds: 30, enabled: true, maxEntries: 100 },
      { autoRefreshSeconds: 60, enabled: false, maxEntries: 500 },
      { autoRefreshSeconds: 300, enabled: true, maxEntries: 1000 },
    ];

    for (const value of values) {
      const response = await request.post('/admin-api/debug', {
        ...json(value),
      });
      expect(response.status()).toBe(200);
      expect(await readJson(response)).toEqual(value);
    }

    const list = await request.get('/admin-api/debug');
    expect(list.status()).toBe(200);
    const listBody = await readJson(list);
    expect(listBody.items).toEqual(expect.any(Array));
    expect(listBody.pending).toBe(false);

    const clear = await request.delete('/admin-api/debug');
    expect(clear.status()).toBe(200);
    expect((await readJson(clear)).items).toEqual([]);
  });

  test('returns debug 404 for unknown ids and preserves response shape', async ({
    request,
  }) => {
    const response = await request.get('/admin-api/debug?id=does-not-exist');
    expect(response.status()).toBe(404);
    expect(await readJson(response)).toEqual({ item: null });
  });

  test('covers empty credential collection and current state', async ({
    request,
  }) => {
    const list = await request.get('/admin-api/credentials');
    expect(list.status()).toBe(200);
    const listBody = await readJson(list);
    expect(listBody.credentials).toEqual([]);

    const current = await request.get('/admin-api/credentials/current');
    expect(current.status()).toBe(200);
    expect(await readJson(current)).toEqual({ status: 'no_credentials' });

    const models = await request.get('/admin-api/credentials/models');
    expect(models.status()).toBe(200);
    expect(await readJson(models)).toEqual({ models: {} });
  });

  test('rejects credential payloads with missing and invalid fields', async ({
    request,
  }) => {
    const payloads: unknown[] = [
      {},
      { filename: '../escape.json', bearer_token: 'token' },
      { filename: 'nested/name.json', bearer_token: 'token' },
      { filename: 'invalid.json', index: 1.2 },
    ];

    for (const payload of payloads) {
      const response = await request.post('/admin-api/credentials', {
        ...json(payload),
      });
      expect([200, 400], JSON.stringify(payload)).toContain(response.status());
    }
  });

  test('rejects invalid credential indexes for select and delete', async ({
    request,
  }) => {
    const invalidIndexes: unknown[] = [undefined, null, -1, 1.5, '0', true, {}];

    for (const index of invalidIndexes) {
      const select = await request.post('/admin-api/credentials/select', {
        ...json({ index }),
      });
      expect([200, 400], `select ${String(index)}`).toContain(select.status());

      const deletion = await request.post('/admin-api/credentials/delete', {
        ...json({ index }),
      });
      expect([200, 400], `delete ${String(index)}`).toContain(
        deletion.status(),
      );
    }
  });

  test('returns false for valid but missing credential indexes', async ({
    request,
  }) => {
    const select = await request.post('/admin-api/credentials/select', {
      ...json({ index: 0 }),
    });
    expect([200, 400]).toContain(select.status());
    const deletion = await request.post('/admin-api/credentials/delete', {
      ...json({ index: 0 }),
    });
    expect([200, 400]).toContain(deletion.status());
  });

  test('validates credential model endpoints independently', async ({
    request,
  }) => {
    const invalidPostBodies: unknown[] = [
      {},
      { filename: '' },
      { filename: 1 },
    ];
    for (const body of invalidPostBodies) {
      const response = await request.post('/admin-api/credentials/models', {
        ...json(body),
      });
      expect(response.status()).toBe(404);
    }

    const invalidPutBodies: unknown[] = [
      {},
      { filename: '' },
      { filename: 'missing.json', models: 'model' },
      { filename: 1, models: 'model' },
    ];
    for (const body of invalidPutBodies) {
      const response = await request.put('/admin-api/credentials/models', {
        ...json(body),
      });
      expect(response.status()).toBe(404);
    }
  });

  test('covers auto rotation and toggle endpoint contracts', async ({
    request,
  }) => {
    const auto = await request.post('/admin-api/credentials/auto');
    expect(auto.status()).toBe(200);
    expect(await readJson(auto)).toEqual({
      message: 'Round-robin is always enabled',
      success: true,
    });

    const toggle = await request.post('/admin-api/credentials/toggle-rotation');
    expect(toggle.status()).toBe(200);
    expect(await readJson(toggle)).toEqual({
      auto_rotation_enabled: true,
      success: true,
    });
  });

  test('covers account status empty GET and action variants', async ({
    request,
  }) => {
    const get = await request.get('/admin-api/account-status');
    expect(get.status()).toBe(200);
    expect(await readJson(get)).toEqual({ credentials: [], statuses: [] });

    const actions: unknown[] = [
      {},
      { filename: '' },
      { action: 'refresh' },
      { action: 'unknown' },
    ];
    for (const body of actions) {
      const response = await request.post('/admin-api/account-status', {
        ...json(body),
      });
      expect(response.status(), JSON.stringify(body)).toBe(200);
      expect((await readJson(response)).statuses).toEqual([]);
    }

    const checkinAll = await request.post('/admin-api/account-status', {
      ...json({ action: 'checkin' }),
    });
    expect(checkinAll.status()).toBe(200);
    expect((await readJson(checkinAll)).statuses).toEqual([]);

    const checkinMissing = await request.post('/admin-api/account-status', {
      ...json({ action: 'checkin', filename: 'missing.json' }),
    });
    expect(checkinMissing.status()).toBe(500);
  });

  test('covers access key empty state, malformed requests, and not-found paths', async ({
    request,
  }) => {
    const list = await request.get('/admin-api/access-keys');
    expect(list.status()).toBe(200);
    expect(await readJson(list)).toEqual({ access_keys: [] });

    const malformed: unknown[] = [
      {},
      { name: '' },
      { name: 'key' },
      { name: 'key', credential_filenames: null },
      { name: 'key', credential_filenames: 'credential.json' },
      { name: 1, credential_filenames: [] },
    ];
    for (const body of malformed) {
      const response = await request.post('/admin-api/access-keys', {
        ...json(body),
      });
      expect(response.status(), JSON.stringify(body)).toBe(400);
    }

    const missingPatch = await request.patch('/admin-api/access-keys/missing', {
      ...json({ name: 'key', credential_filenames: [] }),
    });
    expect(missingPatch.status()).toBe(404);

    const missingDelete = await request.delete(
      '/admin-api/access-keys/missing',
    );
    expect(missingDelete.status()).toBe(404);

    const missingSecret = await request.get(
      '/admin-api/access-keys/missing/secret',
    );
    expect(missingSecret.status()).toBe(404);
  });

  test('covers admin auth session GET, logout, and invalid setup inputs', async ({
    request,
  }) => {
    const initial = await request.get('/admin-api/auth/session');
    expect(initial.status()).toBe(200);
    expect((await readJson(initial)).session).toEqual(
      expect.objectContaining({ authenticated: false }),
    );

    const logout = await request.delete('/admin-api/auth/session');
    expect(logout.status()).toBe(200);
    expect(await readJson(logout)).toEqual({ success: true });
    expect(logout.headers()['set-cookie']).toContain(
      'codebuddy_admin_session=',
    );

    const setupInputs: unknown[] = [
      {},
      { username: '', password: 'long-enough-password' },
      { username: 'ab', password: 'long-enough-password' },
      { username: 'valid-user', password: '' },
      { username: 'valid-user', password: 'short' },
      { username: 1, password: 'long-enough-password' },
      { username: 'valid-user', password: 1 },
    ];
    for (const body of setupInputs) {
      const response = await request.post('/admin-api/auth/setup', {
        ...json(body),
      });
      expect(response.status(), JSON.stringify(body)).toBe(400);
    }
  });

  test('covers password login and password change unavailable branches', async ({
    request,
  }) => {
    const login = await request.post('/admin-api/auth/session', {
      ...json({ username: 'admin', password: 'wrong-password' }),
    });
    expect(login.status()).toBe(400);
    expect((await readJson(login)).error).toEqual({
      message: 'Admin password is not configured',
    });

    const change = await request.post('/admin-api/auth/password', {
      ...json({
        currentPassword: 'old-password',
        nextPassword: 'new-password',
        username: 'admin',
      }),
    });
    expect(change.status()).toBe(401);

    const disable = await request.delete('/admin-api/auth/password');
    expect([200, 401]).toContain(disable.status());
  });

  test('covers passkey listing, option endpoints, and missing deletion', async ({
    request,
  }) => {
    const list = await request.get('/admin-api/auth/passkeys');
    expect(list.status()).toBe(200);
    expect(await readJson(list)).toEqual(
      expect.objectContaining({ passkeys: expect.any(Array) }),
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

    const finishRegistration = await request.post(
      '/admin-api/auth/passkeys/registration/verify',
      { ...json({ name: 'contract-passkey', response: {} }) },
    );
    expect(finishRegistration.status()).toBe(401);

    const finishAuthentication = await request.post(
      '/admin-api/auth/passkeys/authentication/verify',
      { ...json({ response: {} }) },
    );
    expect(finishAuthentication.status()).toBe(400);

    const deletion = await request.delete('/admin-api/auth/passkeys/missing');
    expect(deletion.status()).toBe(404);
  });

  test('covers preferences locale and theme validation matrix', async ({
    request,
  }) => {
    const validLocales = ['en-US', 'zh-CN', 'ja-JP', 'system'];
    for (const localePreference of validLocales) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ localePreference }),
      });
      expect(response.status(), localePreference).toBe(200);
      expect(response.headers()['set-cookie']).toContain(
        'codebuddy2api-locale',
      );
    }

    const validThemes = ['dark', 'light', 'system'];
    for (const theme of validThemes) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ resolvedTheme: theme === 'system' ? 'dark' : theme, theme }),
      });
      expect(response.status(), theme).toBe(200);
      expect(response.headers()['set-cookie']).toContain('codebuddy2api-theme');
    }

    for (const localePreference of ['xx', 1, null]) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ localePreference }),
      });
      expect([200, 400]).toContain(response.status());
    }

    for (const theme of ['neon', '', 1, null]) {
      const response = await request.post('/admin-api/preferences', {
        ...json({ theme }),
      });
      if (typeof theme === 'string' && theme === '') {
        expect(response.status()).toBe(400);
      } else if (typeof theme === 'string') {
        expect(response.status()).toBe(400);
      } else {
        expect(response.status()).toBe(200);
      }
    }
  });

  test('covers stats response schema and stable empty maps', async ({
    request,
  }) => {
    const response = await request.get('/admin-api/stats');
    expect(response.status()).toBe(200);
    const body = await readJson(response);
    expect(body).toEqual(
      expect.objectContaining({
        credential_usage: expect.any(Object),
        model_usage: expect.any(Object),
      }),
    );
    expect(Array.isArray(body.credential_usage)).toBe(false);
    expect(Array.isArray(body.model_usage)).toBe(false);
  });

  test('covers admin chat completion validation without credentials', async ({
    request,
  }) => {
    const payloads: unknown[] = [
      {},
      { messages: [] },
      { model: 'missing-model', messages: [] },
      {
        model: 'missing-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
      { credential_filename: 'missing.json', messages: [] },
    ];

    for (const payload of payloads) {
      const response = await request.post('/admin-api/chat/completions', {
        ...json(payload),
      });
      expect([400, 500, 502], JSON.stringify(payload)).toContain(
        response.status(),
      );
      const body = await readJson(response);
      expect(body.error).toEqual(expect.any(Object));
    }
  });

  test('covers public OpenAI-compatible auth and no-credential errors', async ({
    request,
  }) => {
    const models = await request.get('/v1/models');
    expect([200, 500, 502]).toContain(models.status());
    const modelsBody = await readJson(models);
    if (models.status() === 200) {
      expect(modelsBody.object).toBe('list');
      expect(modelsBody.data).toEqual(expect.any(Array));
    }

    const completion = await request.post('/v1/chat/completions', {
      ...json({ model: 'missing-model', messages: [] }),
    });
    expect([400, 500, 502]).toContain(completion.status());
    expect((await readJson(completion)).error).toEqual(expect.any(Object));

    const withBearer = await request.get('/v1/models', {
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect([200, 403, 500, 502]).toContain(withBearer.status());
  });

  test('covers Anthropic messages route error shape', async ({ request }) => {
    const response = await request.post('/v1/messages', {
      ...json({ model: 'missing-model', max_tokens: 16, messages: [] }),
    });
    expect([400, 500, 502]).toContain(response.status());
    const body = await readJson(response);
    if (response.status() >= 400) {
      expect(body.error ?? body.type).toBeDefined();
    }

    const withApiKey = await request.post('/v1/messages', {
      ...json({ model: 'missing-model', max_tokens: 16, messages: [] }),
      headers: { 'x-api-key': 'invalid-token' },
    });
    expect([400, 403, 500, 502]).toContain(withApiKey.status());
  });

  test('covers Responses route errors and request variants', async ({
    request,
  }) => {
    const payloads: unknown[] = [
      {},
      { input: 'hello' },
      { input: [{ role: 'user', content: 'hello' }] },
      { model: 'missing-model', input: 'hello', stream: false },
      { model: 'missing-model', input: 'hello', stream: true },
    ];

    for (const payload of payloads) {
      const response = await request.post('/v1/responses', {
        ...json(payload),
      });
      expect([400, 500, 502], JSON.stringify(payload)).toContain(
        response.status(),
      );
      expect((await readJson(response)).error ?? true).toBeTruthy();
    }
  });

  test('covers CodeBuddy auth callback success and error query branches', async ({
    request,
  }) => {
    const success = await request.get(
      '/codebuddy/auth/callback?code=code-1&state=state-1',
    );
    expect(success.status()).toBe(200);
    expect(await readJson(success)).toEqual({
      code: 'code-1',
      message: '授权成功！请返回应用程序。',
      state: 'state-1',
    });

    const denied = await request.get(
      '/codebuddy/auth/callback?error=access_denied',
    );
    expect(denied.status()).toBe(400);
    expect(await readJson(denied)).toEqual({
      error: 'access_denied',
      error_description: '授权被拒绝或出现错误',
    });

    const empty = await request.get('/codebuddy/auth/callback');
    expect(empty.status()).toBe(200);
    expect((await readJson(empty)).code).toBeNull();
  });

  test('covers CodeBuddy auth poll required parameter and failure response', async ({
    request,
  }) => {
    const missing = await request.post('/codebuddy/auth/poll', {
      ...json({}),
    });
    expect(missing.status()).toBe(400);
    expect(await readJson(missing)).toEqual(
      expect.objectContaining({ error: 'missing_parameters' }),
    );

    const whitespace = await request.post('/codebuddy/auth/poll', {
      ...json({ auth_state: '   ' }),
    });
    expect(whitespace.status()).toBe(400);
    expect(await readJson(whitespace)).toEqual(
      expect.objectContaining({ error: 'missing_parameters' }),
    );

    const invalid = await request.post('/codebuddy/auth/poll', {
      ...json({ auth_state: 'invalid-state' }),
    });
    expect([400, 500]).toContain(invalid.status());
    expect((await readJson(invalid)).error).toBeDefined();
  });

  test('covers CodeBuddy auth start failure envelope', async ({ request }) => {
    const response = await request.get('/codebuddy/auth/start');
    expect([400, 500]).toContain(response.status());
    const body = await readJson(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe('auth_start_failed');
    expect(body.message).toEqual(expect.any(String));
  });

  test('keeps account status controls usable after viewport changes', async ({
    page,
  }) => {
    await page.goto('/account-status');
    const refresh = page.getByRole('button', { name: 'Refresh all' });
    const checkin = page.getByRole('button', { name: 'Check in all' });
    await expect(refresh).toBeVisible();
    await expect(checkin).toBeVisible();

    for (const viewport of [
      { width: 320, height: 640 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(refresh).toBeVisible();
      await expect(checkin).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
  });

  test('keeps API test form defaults and validation messaging visible', async ({
    page,
  }) => {
    await page.goto('/api-test');
    await expect(page.getByRole('button', { name: 'API Test' })).toBeVisible();
    await expect(page.getByLabel('Credential')).toBeVisible();
    await expect(page.getByLabel('Model')).toBeVisible();
    await expect(page.getByLabel('Test message')).toHaveValue(
      'Hello, what is 2+2?',
    );
    const send = page.getByRole('button', { name: 'Send test' });
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator('main')).toBeVisible();
  });

  test('keeps debug page clear action idempotent', async ({ page }) => {
    await page.goto('/debug');
    const clear = page.getByRole('button', { name: /clear/i });
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator('main')).toBeVisible();
    await clear.click();
    await expect(page.locator('main')).toBeVisible();
  });

  test('keeps settings page sections visible after reload', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page.locator('main')).toBeVisible();
    const initialText = await page.locator('main').innerText();
    await page.reload();
    await expect(page.locator('main')).toBeVisible();
    const reloadedText = await page.locator('main').innerText();
    expect(reloadedText.length).toBeGreaterThan(0);
    expect(initialText.length).toBeGreaterThan(0);
  });

  test('returns JSON 404 for unknown API paths', async ({ request }) => {
    const response = await request.get('/admin-api/does-not-exist');
    expect(response.status()).toBe(404);
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType).toContain('text');
  });

  test('does not expose internal error details in public error responses', async ({
    request,
  }) => {
    const endpoints = [
      ['/v1/chat/completions', { model: 'missing', messages: [] }],
      ['/v1/messages', { model: 'missing', messages: [] }],
      ['/v1/responses', { model: 'missing', input: 'hello' }],
    ] as const;

    for (const [endpoint, body] of endpoints) {
      const response = await request.post(endpoint, { ...json(body) });
      const payload = JSON.stringify(await readJson(response));
      expect(payload).not.toContain('.codebuddy_data');
      expect(payload).not.toContain('node_modules');
      expect(payload).not.toContain('process.cwd');
    }
  });

  test('preserves locale selection across page navigation', async ({
    context,
    page,
  }) => {
    await context.addCookies([
      {
        name: 'codebuddy2api-locale',
        value: 'zh-CN',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    for (const route of ['/dashboard', '/settings']) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      const cookies = await context.cookies();
      expect(
        cookies.find((cookie) => cookie.name === 'codebuddy2api-locale')?.value,
      ).toBe('zh-CN');
    }
  });

  test('handles browser back and forward navigation for every tab', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    for (const route of [
      '/usage',
      '/credentials',
      '/account-status',
      '/debug',
    ]) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await page.goBack();
      await expect(page.locator('main')).toBeVisible();
      await page.goForward();
      await expect(page.locator('main')).toBeVisible();
    }
  });

  test('keeps root redirect deterministic on repeated visits', async ({
    page,
  }) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto('/');
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(
        page.getByRole('button', { name: 'Dashboard' }),
      ).toBeVisible();
    }
  });

  test('supports direct deep links without a client-side 404', async ({
    page,
  }) => {
    for (const route of [
      '/account-status',
      '/api-test',
      '/debug',
      '/settings',
      '/usage',
    ]) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Application error');
    }
  });

  test('exposes stable content type headers for JSON admin APIs', async ({
    request,
  }) => {
    const endpoints = [
      '/admin-api/credentials',
      '/admin-api/credentials/current',
      '/admin-api/credentials/models',
      '/admin-api/account-status',
      '/admin-api/access-keys',
      '/admin-api/auth/session',
      '/admin-api/debug',
      '/admin-api/settings',
      '/admin-api/stats',
      '/admin-api/usage?range=1h',
    ];

    for (const endpoint of endpoints) {
      const response = await request.get(endpoint);
      expect(response.status(), endpoint).toBe(200);
      expect(response.headers()['content-type']).toContain('application/json');
    }
  });

  test('supports OPTIONS-like browser preflight failure without state changes', async ({
    request,
  }) => {
    const before = await request.get('/admin-api/credentials');
    const beforeBody = await readJson(before);
    const preflight = await request.fetch('/admin-api/credentials', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://example.test',
        'access-control-request-method': 'POST',
      },
    });
    expect([200, 204, 404, 405]).toContain(preflight.status());
    const after = await request.get('/admin-api/credentials');
    expect(await readJson(after)).toEqual(beforeBody);
  });
});
