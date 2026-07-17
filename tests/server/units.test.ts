import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  createAccessKey,
  deleteAccessKey,
  findAccessKeyById,
  findAccessKeyBySecret,
  getAccessKeySecret,
  hasAccessKeys,
  listAccessKeys,
  listStoredAccessKeys,
  removeCredentialReferencesFromAccessKeys,
  updateAccessKey,
} from '@/lib/server/domain/access-keys';
import {
  getAdminAuthErrorResponse,
  getAuthErrorResponse,
  getAnthropicAuthErrorResponse,
  getClientAuthErrorResponse,
  resolveRequestAccessKey,
} from '@/lib/server/proxy/auth';
import {
  getAuthCallbackResponse,
  pollCodeBuddyAuth,
  startCodeBuddyAuth,
} from '@/lib/server/proxy/codebuddy-auth';
import {
  createProxyContextFromCredential,
  getModelsResponse,
  proxyChatCompletions,
  proxyResponsesUpstream,
  resolveProxyContextByCredentialFilename,
} from '@/lib/server/proxy/codebuddy';
import {
  addCredential,
  deleteCredentialByIndex,
  getCurrentCredentialInfo,
  listCredentials,
  resetCredentialRuntimeState,
  resolveCredentialForRequest,
  resumeAutoRotation,
  selectCredential,
  toggleAutoRotation,
  updateCredentialByIndex,
} from '@/lib/server/domain/credentials';
import {
  handleResponsesRequest,
  resetResponseSessions,
  translateResponsesToolsToChat,
} from '@/lib/server/proxy/responses';
import { updateSettings, getActiveConfig } from '@/lib/server/domain/config';
import { getRequestHeaderMap } from '@/lib/server/shared/http';
import { getUsageStats, resetUsageStats } from '@/lib/server/domain/stats';
import {
  clearDebugLogs,
  createDebugTrace,
  enqueueUpstreamResponseSnapshot,
  finalizeDebugTrace,
  getDebugSettings,
  isDebugEnabled,
  listDebugLogs,
  setDebugTraceError,
  setDebugUpstreamRequest,
  updateDebugSettings,
} from '@/lib/server/domain/debug';
import {
  clearUsageHistory,
  getUsageAnalytics,
  recordUsageEvent,
} from '@/lib/server/domain/usage';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-config-units-root');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');
const tempAccessKeysPath = path.join(tempDataDir, 'access-keys.json');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const makeNextRequest = (
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest => {
  return new NextRequest(url, init);
};

const makeJsonResponse = (
  payload: Record<string, unknown>,
  status = 200,
): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

const waitForAsync = async (
  assertion: () => Promise<void>,
  timeoutMs = 1000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
};

describe('server units', () => {
  beforeEach(async () => {
    cleanupTempState();
    resetCredentialRuntimeState();
    resetResponseSessions();
    await resetUsageStats();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_CONFIG_PATH;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_API_KEY = '';
    fs.rmSync(tempAccessKeysPath, { force: true });
    await addCredential({
      bearer_token: 'default-test-token',
      first_message_role_to_system: false,
      responses_passthrough: false,
      user_id: 'default@example.com',
    });
  });

  afterEach(() => {
    cleanupTempState();
    delete process.env.CODEBUDDY_API_KEY;
    vi.useRealTimers();
  });

  it('masks sensitive debug headers and body fields', () => {
    const requestKey = 'cb2_request_key_1234567890';
    const requestUserId = 'request-user-id-1234567890';
    const upstreamUserId = 'upstream-user-id-1234567890';
    const trace = createDebugTrace({
      requestBody: {
        authorization: 'Bearer request-authorization-token',
        nested: {
          x_user_id: requestUserId,
        },
      },
      requestKey,
      route: '/v1/responses',
    });

    setDebugUpstreamRequest(trace, {
      body: {
        user_id: upstreamUserId,
      },
      headers: {
        authorization: 'Bearer upstream-authorization-token',
        'x-api-key': 'upstream-api-key-1234567890',
        'x-user-id': upstreamUserId,
      },
      method: 'POST',
      url: 'https://example.com/v1/chat/completions',
    });

    expect(JSON.stringify(trace)).not.toContain(requestKey);
    expect(JSON.stringify(trace)).not.toContain(requestUserId);
    expect(JSON.stringify(trace)).not.toContain(upstreamUserId);
    expect(trace.requestKey).toMatch(/^cb2_requ\.\.\./);
    expect(trace.upstreamRequest?.headers.authorization).toMatch(
      /^Bearer upstrea/,
    );
    expect(trace.upstreamRequest?.headers['x-api-key']).toMatch(
      /^upstream\.\.\./,
    );
    expect(trace.upstreamRequest?.headers['x-user-id']).toMatch(
      /^upstream\.\.\./,
    );
  });

  it('covers auth guard branches', async () => {
    expect(
      await getClientAuthErrorResponse(
        makeNextRequest('http://localhost/test'),
      ),
    ).toBeNull();

    const credential = await addCredential({
      bearer_token: 'token-auth',
      user_id: 'guard@example.com',
    });
    const created = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Guard Key',
    });

    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test'),
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Basic nope' },
          }),
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Basic nope' },
          }),
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await getAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Bearer nope' },
          }),
        )
      )?.status,
    ).toBe(403);
    expect(
      await getClientAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: `Bearer ${created.secret} trailing` },
        }),
      ),
    ).toBeNull();
    expect(
      await getAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { 'x-api-key': created.secret },
        }),
      ),
    ).toBeNull();
    expect(
      await getClientAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { 'x-api-key': created.secret },
        }),
      ),
    ).toBeNull();
  });

  it('requires access keys once they are configured', async () => {
    const credential = await addCredential({
      bearer_token: 'token-auth',
      user_id: 'guard@example.com',
    });
    const created = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Guard Key',
    });

    expect(
      await getClientAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: `Bearer ${created.secret}` },
        }),
      ),
    ).toBeNull();
    expect(
      await getAdminAuthErrorResponse(
        makeNextRequest('http://localhost/admin', {
          headers: { authorization: `Bearer ${created.secret}` },
        }),
      ),
    ).toBeNull();
    expect(
      (
        await getAdminAuthErrorResponse(
          makeNextRequest('http://localhost/admin', {
            headers: { authorization: 'Bearer wrong-secret' },
          }),
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await resolveRequestAccessKey(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: `Bearer ${created.secret}` },
          }),
        )
      )?.id,
    ).toBe(created.access_key.id);
    expect(
      await resolveRequestAccessKey(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: 'Bearer wrong-secret' },
        }),
      ),
    ).toBeNull();
  });

  it('covers auth behavior when access key storage is unreadable', async () => {
    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(path.join(tempDataDir, 'access-keys.json'), '{');

    expect(
      await resolveRequestAccessKey(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: 'Bearer any-token' },
        }),
      ),
    ).toBeNull();

    const clientError = await getClientAuthErrorResponse(
      makeNextRequest('http://localhost/test', {
        headers: { authorization: 'Bearer any-token' },
      }),
    );
    expect(clientError?.status).toBe(503);
    expect(await clientError?.json()).toEqual({
      error: {
        message:
          'Access key storage is unreadable. Fix access-keys.json first.',
      },
    });

    const adminError = await getAdminAuthErrorResponse(
      makeNextRequest('http://localhost/admin', {
        headers: { authorization: 'Bearer any-token' },
      }),
    );
    expect(adminError?.status).toBe(503);

    const anthropicError = await getAnthropicAuthErrorResponse(
      makeNextRequest('http://localhost/v1/messages', {
        headers: { authorization: 'Bearer any-token' },
      }),
    );
    expect(anthropicError?.status).toBe(503);
    expect(await anthropicError?.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'authentication_error',
      },
    });
  });

  it('covers anthropic auth with x-api-key and bearer', async () => {
    // No password configured — both pass.
    expect(
      await getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages'),
      ),
    ).toBeNull();

    const credential = await addCredential({
      bearer_token: 'token-anthropic',
      user_id: 'anthropic@example.com',
    });
    const { secret } = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Anthropic Key',
    });

    // Missing key entirely.
    const noKey = await getAnthropicAuthErrorResponse(
      makeNextRequest('http://localhost/v1/messages'),
    );
    expect(noKey?.status).toBe(401);
    expect((await noKey!.json()).type).toBe('error');

    // Wrong key via x-api-key.
    const wrongKey = await getAnthropicAuthErrorResponse(
      makeNextRequest('http://localhost/v1/messages', {
        headers: { 'x-api-key': 'wrong' },
      }),
    );
    expect(wrongKey?.status).toBe(403);
    expect(wrongKey).not.toBeNull();

    // Correct key via x-api-key.
    expect(
      await getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages', {
          headers: { 'x-api-key': secret },
        }),
      ),
    ).toBeNull();

    // Correct key via Authorization: Bearer.
    expect(
      await getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages', {
          headers: { authorization: `Bearer ${secret}` },
        }),
      ),
    ).toBeNull();
  });

  it('covers credential round-robin, invalid operations, and usage stats', async () => {
    while ((await deleteCredentialByIndex(0)).success) {
      // delete all seeded credentials for a clean no-credentials assertion
    }
    expect((await getCurrentCredentialInfo()).status).toBe('no_credentials');
    expect((await selectCredential(0)).success).toBe(false);
    expect((await deleteCredentialByIndex(0)).success).toBe(false);

    await addCredential({
      bearer_token: 'expired',
      created_at: 1,
      expires_in: 1,
      user_id: 'expired@example.com',
    });
    await addCredential({
      bearer_token: 'token-1',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      enterpriseId: 'tenant-a',
      user_id: 'one@example.com',
    });
    await addCredential({
      bearer_token: 'token-2',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      tenant_id: 'tenant-b',
      user_id: 'two@example.com',
    });

    const listed = await listCredentials();
    const expiredCredential = listed.credentials.find((item) => {
      return item.user_id === 'expired@example.com' || item.is_expired === true;
    });
    const tenantCredential = listed.credentials.find(
      (item) => item.user_id === 'one@example.com',
    );
    expect(expiredCredential?.is_expired).toBe(true);
    expect(tenantCredential?.tenant_id).toBe('tenant-a');

    const first = await resolveCredentialForRequest();
    const second = await resolveCredentialForRequest();
    expect(first?.data.user_id).toBe('one@example.com');
    expect(second?.data.user_id).toBe('two@example.com');

    expect((await selectCredential(1)).success).toBe(true);
    expect((await resolveCredentialForRequest())?.data.user_id).toBe(
      'one@example.com',
    );

    const toggle = toggleAutoRotation();
    expect(toggle.auto_rotation_enabled).toBe(true);
    expect(resumeAutoRotation().success).toBe(true);

    const keyedCredential = await addCredential({
      bearer_token: 'token-3',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      user_id: 'keyed@example.com',
    });
    const keyedAccess = await createAccessKey({
      credentialFilenames: [keyedCredential.filename],
      name: 'Subset Key',
    });
    expect(
      (
        await resolveCredentialForRequest({
          accessKeyId: keyedAccess.access_key.id,
          allowedCredentialFilenames:
            keyedAccess.access_key.credentialFilenames,
        })
      )?.filename,
    ).toBe(keyedCredential.filename);

    await recordUsageEvent({
      credentialFilename: 'cred-a',
      model: 'glm-5.1',
      route: '/v1/chat/completions',
      usage: {
        total_tokens: 7,
      },
    });
    expect((await getUsageStats()).model_usage['glm-5.1']).toBe(1);
    expect((await getUsageStats()).credential_usage['cred-a']).toBeUndefined();
  });

  it('keeps affinity assignments stable and clears them when credentials disappear', async () => {
    while ((await deleteCredentialByIndex(0)).success) {
      // clear seeded credentials to make affinity selection deterministic
    }

    const firstCredential = await addCredential({
      bearer_token: 'token-affinity-1',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      user_id: 'affinity-one@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-affinity-2',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      user_id: 'affinity-two@example.com',
    });
    const allowedCredentialFilenames = [
      firstCredential.filename,
      secondCredential.filename,
    ];

    const firstResolved = await resolveCredentialForRequest({
      affinityKey: 'conversation:stable',
      allowedCredentialFilenames,
    });
    const secondResolved = await resolveCredentialForRequest({
      affinityKey: 'conversation:stable',
      allowedCredentialFilenames,
    });

    expect(firstResolved?.filename).toBe(firstCredential.filename);
    expect(secondResolved?.filename).toBe(firstCredential.filename);

    const listed = await listCredentials();
    const firstIndex = listed.credentials.findIndex(
      (credential) => credential.filename === firstCredential.filename,
    );
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect((await deleteCredentialByIndex(firstIndex)).success).toBe(true);

    const reassigned = await resolveCredentialForRequest({
      affinityKey: 'conversation:stable',
      allowedCredentialFilenames,
    });
    expect(reassigned?.filename).toBe(secondCredential.filename);
  });

  it('persists usage history under file storage and preserves historical filters', async () => {
    const now = new Date('2026-07-11T12:30:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await recordUsageEvent({
      accessKeyId: 'key-1',
      accessKeyName: 'Team Key',
      credentialFilename: 'legacy-credential.json',
      model: 'glm-5.1',
      route: '/v1/chat/completions',
      timestamp: '2026-07-11T11:45:00.000Z',
      usage: {
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        input_tokens: 10,
        output_tokens: 5,
      },
    });

    await recordUsageEvent({
      accessKeyId: 'key-2',
      accessKeyName: 'Other Key',
      credentialFilename: 'legacy-credential.json',
      model: 'glm-4.7',
      route: '/v1/responses',
      timestamp: '2026-07-10T12:15:00.000Z',
      usage: {
        total_tokens: 8,
      },
    });

    const usagePath = path.join(tempDataDir, 'usage-history.json');
    await getUsageAnalytics({ now, range: '24h' });

    expect(fs.existsSync(usagePath)).toBe(true);
    expect(fs.existsSync(`${usagePath}.tmp`)).toBe(false);

    const persisted = JSON.parse(fs.readFileSync(usagePath, 'utf8')) as {
      events: Array<Record<string, unknown>>;
    };
    expect(persisted.events).toHaveLength(2);

    const analytics = await getUsageAnalytics({
      now,
      range: '24h',
    });
    expect(analytics.tableRows).toHaveLength(1);
    expect(analytics.tableRows[0]).toMatchObject({
      callCount: 1,
      cacheHitTokens: 2,
      model: 'glm-5.1',
      totalTokens: 20,
    });

    await recordUsageEvent({
      accessKeyId: 'key-1',
      accessKeyName: 'Team Key',
      credentialFilename: 'legacy-credential.json',
      model: 'glm-5.1',
      route: '/v1/chat/completions',
      timestamp: '2026-07-11T11:50:00.000Z',
      usage: {
        completion_tokens: 4,
        prompt_tokens: 16,
        prompt_tokens_details: {
          cached_tokens: 6,
          cache_creation_tokens: 4,
        },
      },
    });

    const openAIAnalytics = await getUsageAnalytics({
      now,
      range: '24h',
    });
    expect(openAIAnalytics.tableRows[0]).toMatchObject({
      cacheHitTokens: 8,
      model: 'glm-5.1',
      totalTokens: 40,
    });
    expect(analytics.tokenSeries[0]?.points).toHaveLength(24);
    expect(
      analytics.filters.accessKeys.some((item) => item.value === 'key-1'),
    ).toBe(true);
    expect(
      analytics.filters.credentials.some(
        (item) => item.value === 'legacy-credential.json',
      ),
    ).toBe(true);

    const filtered = await getUsageAnalytics({
      accessKey: 'key-2',
      credential: 'legacy-credential.json',
      now,
      range: '3d',
    });
    expect(filtered.tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'glm-4.7',
        totalTokens: 8,
      },
    ]);
    expect(filtered.todaySummary.callCount).toBe(0);
  });

  it('sanitizes invalid persisted usage records and clears usage history', async () => {
    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDataDir, 'usage-history.json'),
      JSON.stringify({
        events: [
          {
            accessKeyId: 'key-1',
            accessKeyName: 'Team Key',
            cacheCreationTokens: '4',
            cacheReadTokens: -1,
            callCount: 0,
            credentialFilename: 'cred.json',
            inputTokens: '7',
            model: ' glm-5.1 ',
            outputTokens: 3,
            route: '/v1/chat/completions',
            timestamp: '2026-07-11T11:00:00.000Z',
            totalTokens: '15',
          },
          {
            model: 'broken',
            route: '/v1/chat/completions',
          },
        ],
      }),
    );

    const analytics = await getUsageAnalytics({
      now: new Date('2026-07-11T12:30:00.000Z'),
      range: 'today',
    });
    expect(analytics.tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'glm-5.1',
        totalTokens: 15,
      },
    ]);
    expect(analytics.tokenSeries[0]?.points).toHaveLength(24);

    await clearUsageHistory();
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tempDataDir, 'usage-history.json'), 'utf8'),
      ),
    ).toEqual({
      events: [],
    });
  });

  it('persists debug settings and captures request and response snapshots', async () => {
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    });

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDataDir, 'debug-settings.json'),
      JSON.stringify({
        autoRefreshSeconds: 7,
        enabled: 'yes',
        maxEntries: -1,
      }),
    );
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    });

    expect(
      await updateDebugSettings({
        autoRefreshSeconds: 15,
        enabled: true,
        maxEntries: 2000,
      }),
    ).toEqual({
      autoRefreshSeconds: 15,
      enabled: true,
      maxEntries: 1000,
    });
    expect(await isDebugEnabled()).toBe(true);

    fs.writeFileSync(
      path.join(tempDataDir, 'debug-logs.json'),
      JSON.stringify([
        null,
        {
          createdAt: '2026-07-11T10:00:00.000Z',
          id: 'valid-log',
          route: '/v1/responses',
        },
        {
          id: 'invalid-log',
        },
      ]),
    );
    expect(await listDebugLogs()).toHaveLength(1);
    await clearDebugLogs();
    expect(await listDebugLogs()).toEqual([]);

    setDebugTraceError(undefined, new Error('ignored'));
    setDebugUpstreamRequest(undefined, {
      body: null,
      headers: {},
      method: 'POST',
      url: 'https://example.com',
    });
    enqueueUpstreamResponseSnapshot(undefined, new Response());
    finalizeDebugTrace(undefined, new Response());

    const trace = createDebugTrace({
      requestBody: {
        model: 'gpt-5.5',
      },
      requestKey: 'credential.json',
      route: '/v1/responses',
    });
    setDebugTraceError(trace, 'upstream warning');
    setDebugUpstreamRequest(trace, {
      body: {
        input: 'hello',
      },
      headers: {
        authorization: 'Bearer [redacted]',
      },
      method: 'POST',
      url: 'https://example.com/v1/responses',
    });
    enqueueUpstreamResponseSnapshot(
      trace,
      makeJsonResponse({
        id: 'resp_upstream',
      }),
    );
    finalizeDebugTrace(
      trace,
      new Response('completed', {
        headers: {
          'Content-Type': 'text/plain',
        },
        status: 202,
      }),
    );

    await vi.waitFor(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });

    expect((await listDebugLogs())[0]).toMatchObject({
      error: 'upstream warning',
      requestBody: {
        model: 'gpt-5.5',
      },
      requestKey: 'credenti...json',
      route: '/v1/responses',
      transformedResponse: {
        body: 'completed',
        status: 202,
      },
      upstreamRequest: {
        method: 'POST',
        url: 'https://example.com/v1/responses',
      },
      upstreamResponse: {
        body: {
          id: 'resp_upstream',
        },
        status: 200,
      },
    });
  });

  it('covers access key store edge cases and mutation failures', async () => {
    expect(await hasAccessKeys()).toBe(false);
    expect(await findAccessKeyBySecret('   ')).toBeNull();
    expect(await getAccessKeySecret('missing')).toBeNull();
    expect(await deleteAccessKey('missing')).toBe(false);
    expect((await listAccessKeys()).access_keys).toEqual([]);
    expect(await listStoredAccessKeys()).toEqual([]);

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDataDir, 'access-keys.json'),
      JSON.stringify({
        accessKeys: [
          {
            id: 'valid-id',
            name: 'Valid Key',
            secret: 'shortsecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: ['cred-b.json', 'cred-a.json'],
          },
          {
            id: 'invalid-id',
            name: 'Broken Key',
            credentialFilenames: 'bad-shape',
          },
        ],
      }),
    );

    expect(await hasAccessKeys()).toBe(false);
    expect(await findAccessKeyById('valid-id')).toBeNull();
    expect(await findAccessKeyBySecret('shortsecret')).toBeNull();
    expect(await getAccessKeySecret('valid-id')).toBeNull();
    expect(await listStoredAccessKeys()).toEqual([]);
    expect((await listAccessKeys()).access_keys).toEqual([]);

    fs.writeFileSync(path.join(tempDataDir, 'access-keys.json'), '{');
    expect(await listStoredAccessKeys()).toEqual([]);
    expect(await hasAccessKeys()).toBe(false);
    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Bearer anything' },
          }),
        )
      )?.status,
    ).toBe(503);

    fs.writeFileSync(path.join(tempDataDir, 'access-keys.json'), '');
    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Bearer anything' },
          }),
        )
      )?.status,
    ).toBe(503);

    fs.writeFileSync(path.join(tempDataDir, 'access-keys.json'), 'null');
    expect(
      (
        await getClientAuthErrorResponse(
          makeNextRequest('http://localhost/test', {
            headers: { authorization: 'Bearer anything' },
          }),
        )
      )?.status,
    ).toBe(503);
  });

  it('covers access key validation, normalization, and deletion', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });

    await expect(
      createAccessKey({
        credentialFilenames: [firstCredential.filename],
        name: '   ',
      }),
    ).rejects.toThrow('Access key name is required');
    await expect(
      createAccessKey({
        credentialFilenames: ['   '],
        name: 'Missing Credentials',
      }),
    ).rejects.toThrow('At least one credential must be selected');

    const created = await createAccessKey({
      credentialFilenames: [
        ` ${secondCredential.filename} `,
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: '  Mixed Key  ',
    });
    expect(created.access_key.name).toBe('Mixed Key');
    expect(created.access_key.credentialFilenames).toEqual([
      firstCredential.filename,
      secondCredential.filename,
    ]);
    expect(created.secret.startsWith('cb2_')).toBe(true);
    expect(created.access_key.maskedSecret).toContain('...');

    await expect(
      updateAccessKey(created.access_key.id, {
        credentialFilenames: [firstCredential.filename],
        name: '   ',
      }),
    ).rejects.toThrow('Access key name is required');
    await expect(
      updateAccessKey(created.access_key.id, {
        credentialFilenames: [],
        name: 'Still Bad',
      }),
    ).rejects.toThrow('At least one credential must be selected');
    await expect(
      updateAccessKey('missing-id', {
        credentialFilenames: [firstCredential.filename],
        name: 'Unknown Key',
      }),
    ).rejects.toThrow('Access key not found');

    const updated = await updateAccessKey(created.access_key.id, {
      credentialFilenames: [secondCredential.filename],
      name: 'Updated Key',
    });
    expect(updated.name).toBe('Updated Key');
    expect(updated.credentialFilenames).toEqual([secondCredential.filename]);

    expect(await deleteAccessKey(created.access_key.id)).toBe(true);
    expect(await findAccessKeyById(created.access_key.id)).toBeNull();
    expect(await getAccessKeySecret(created.access_key.id)).toBeNull();
  });

  it('removes deleted credential references from access keys', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });
    const singleCredential = await addCredential({
      bearer_token: 'token-third',
      user_id: 'third@example.com',
    });

    const multiKey = await createAccessKey({
      credentialFilenames: [
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: 'Multi Key',
    });
    const singleKey = await createAccessKey({
      credentialFilenames: [singleCredential.filename],
      name: 'Single Key',
    });

    const listed = await listCredentials();
    const secondIndex = listed.credentials.findIndex(
      (credential) => credential.filename === secondCredential.filename,
    );
    expect((await deleteCredentialByIndex(secondIndex)).success).toBe(true);
    expect(
      (await findAccessKeyById(multiKey.access_key.id))?.credentialFilenames,
    ).toEqual([firstCredential.filename]);

    const refreshedCredentials = await listCredentials();
    const refreshedSingleIndex = refreshedCredentials.credentials.findIndex(
      (credential) => credential.filename === singleCredential.filename,
    );
    expect((await deleteCredentialByIndex(refreshedSingleIndex)).success).toBe(
      true,
    );
    expect(await findAccessKeyById(singleKey.access_key.id)).toBeNull();
  });

  it('prunes stale credential references when reading access keys', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDataDir, 'access-keys.json'),
      JSON.stringify({
        accessKeys: [
          {
            id: 'stale-and-valid',
            name: 'Stale and Valid',
            secret: 'cb2_validsecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: ['missing.json', firstCredential.filename],
          },
          {
            id: 'stale-only',
            name: 'Stale Only',
            secret: 'cb2_stalesecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: ['missing.json'],
          },
        ],
      }),
    );

    expect(await listStoredAccessKeys()).toEqual([
      expect.objectContaining({
        credentialFilenames: [firstCredential.filename],
        id: 'stale-and-valid',
      }),
    ]);
    expect(await hasAccessKeys()).toBe(true);
    expect(await findAccessKeyBySecret('cb2_stalesecret')).toBeNull();

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'access-keys.json'), 'utf8'),
    ) as { accessKeys: Array<{ credentialFilenames: string[]; id: string }> };
    expect(persisted.accessKeys).toHaveLength(1);
  });

  it('supports direct credential reference cleanup helper', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });
    const created = await createAccessKey({
      credentialFilenames: [
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: 'Direct Cleanup Key',
    });

    expect(
      await removeCredentialReferencesFromAccessKeys(secondCredential.filename),
    ).toBe(true);
    expect(
      (await findAccessKeyById(created.access_key.id))?.credentialFilenames,
    ).toEqual([firstCredential.filename]);
    expect(await removeCredentialReferencesFromAccessKeys('missing.json')).toBe(
      false,
    );
  });

  it('covers chat proxy error, token auth, and streaming branches', async () => {
    const missingMessages = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {},
    );
    expect(missingMessages.status).toBe(400);

    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    fs.rmSync(tempAccessKeysPath, { force: true });
    expect(await hasAccessKeys()).toBe(false);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('missing access key', {
          status: 401,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ message: 'bad gateway' }, 502))
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"content":"hi","tool_calls":[{"index":0,"id":"tooluse_weather","type":"function","function":{"name":"look","arguments":"{\\"city\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tooluse_weather","function":{"name":"up","arguments":"Shanghai\\"}"}},{"index":0,"id":"tooluse_news","type":"function","function":{"name":"search","arguments":"{\\"topic\\":\\"tech\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      );
    const missingApiKey = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect(missingApiKey.status).toBe(401);

    await addCredential({
      bearer_token: 'token-a',
      created_at: Math.floor(Date.now() / 1000),
      enterprise_id: 'tenant-a',
      user_id: 'token@example.com',
    });
    process.env.CODEBUDDY_AUTH_MODE = 'token';
    const tokenCredentials = await listCredentials();
    const tokenCredential = tokenCredentials.credentials.find(
      (credential) => credential.user_id === 'token@example.com',
    );
    const tokenAccessKey = await createAccessKey({
      credentialFilenames: [String(tokenCredential?.filename)],
      name: 'Token Mode Key',
    });

    const upstreamFailure = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenAccessKey.secret}`,
        },
      }),
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect(upstreamFailure.status).toBe(502);

    const streaming = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenAccessKey.secret}`,
          'X-Conversation-ID': 'conv-1',
          originator: 'codex',
          session_id: 'session-1',
          traceparent:
            '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
          tracestate: 'vendor=value',
        },
      }),
      {
        messages: [{ role: 'tool', content: 'tool output' }],
        max_completion_tokens: 12,
        stream: true,
      },
    );
    const streamingText = await streaming.text();
    expect(streamingText).toContain('"id":"call_weather"');
    expect(streamingText).toContain('"id":"call_news"');
    expect(streamingText).toContain('"index":0');
    expect(streamingText).toContain('"index":1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      ((fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Headers).get(
        'X-Tenant-Id',
      ),
    ).toBe('tenant-a');
    const upstreamHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit)
      .headers as Headers;
    expect(upstreamHeaders.get('X-Conversation-ID')).toBe('conv-1');
    expect(upstreamHeaders.get('X-Originator')).toBe('codex');
    expect(upstreamHeaders.get('X-Session-ID')).toBe('session-1');
    expect(upstreamHeaders.get('traceparent')).toBe(
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );
    expect(upstreamHeaders.get('tracestate')).toBe('vendor=value');
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))
        .max_tokens,
    ).toBe(12);
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))
        .max_completion_tokens,
    ).toBe(12);
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))
        .response_format,
    ).toBeUndefined();
  });

  it('persists successful proxy calls without upstream usage across runtime restarts', async () => {
    const credential = (await listCredentials()).credentials[0];
    expect(credential).toBeDefined();

    const context = await resolveProxyContextByCredentialFilename(
      String(credential?.filename),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
        model: 'glm-5.1',
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'persist this call', role: 'user' }],
      },
      context,
    );
    expect(response.status).toBe(200);

    resetStorageRuntime();

    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'glm-5.1',
        totalTokens: 0,
      },
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tempDataDir, 'usage-history.json'), 'utf8'),
      ),
    ).toMatchObject({
      events: [
        {
          callCount: 1,
          model: 'glm-5.1',
          totalTokens: 0,
        },
      ],
    });
  });

  it('applies prompt cache control only when it is safe and useful', async () => {
    const credential = (await listCredentials()).credentials[0];
    expect(credential).toBeDefined();

    const context = await resolveProxyContextByCredentialFilename(
      String(credential?.filename),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );
    });
    const longText = 'cached prompt '.repeat(80);

    await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [
          { content: longText, role: 'system' },
          { content: longText, role: 'user' },
        ],
      },
      context,
    );
    await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [
          {
            content: [
              {
                cache_control: { type: 'ephemeral' },
                text: 'explicit cache marker',
                type: 'text',
              },
            ],
            role: 'system',
          },
          { content: longText, role: 'user' },
        ],
      },
      context,
    );
    await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [
          {
            content: [
              { text: 'short text', type: 'text' },
              { text: longText, type: 'text' },
            ],
            role: 'user',
          },
        ],
      },
      context,
    );
    await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      { messages: [{ content: 'short reply', role: 'assistant' }] },
      context,
    );

    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: unknown }> };
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: unknown }> };
    const thirdBody = JSON.parse(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: unknown }> };
    const fourthBody = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: unknown }> };

    expect(firstBody.messages.map((message) => message.content)).toEqual([
      [
        {
          cache_control: { type: 'ephemeral' },
          text: longText,
          type: 'text',
        },
      ],
      [
        {
          cache_control: { type: 'ephemeral' },
          text: longText,
          type: 'text',
        },
      ],
    ]);
    expect(secondBody.messages[1]?.content).toBe(longText);
    expect(thirdBody.messages[0]?.content).toEqual([
      { text: 'short text', type: 'text' },
      {
        cache_control: { type: 'ephemeral' },
        text: longText,
        type: 'text',
      },
    ]);
    expect(fourthBody.messages[0]?.content).toBe('short reply');
  });

  it('normalizes developer messages for chat upstream based on position', async () => {
    await addCredential({
      bearer_token: 'token-dev-role',
      created_at: Math.floor(Date.now() / 1000),
      first_message_role_to_system: true,
      user_id: 'developer-role@example.com',
    });

    const roleCredential = (await listCredentials()).credentials.find(
      (credential) => credential.user_id === 'developer-role@example.com',
    );
    const roleAccessKey = await createAccessKey({
      credentialFilenames: [String(roleCredential?.filename)],
      name: 'Developer Role Key',
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${roleAccessKey.secret}`,
        },
      }),
      {
        messages: [
          { role: 'developer', content: 'first developer' },
          { role: 'user', content: 'hello' },
          { role: 'developer', content: 'later developer' },
          { role: 'system', content: 'existing system' },
          { role: 'developer', content: 'after system developer' },
        ],
        stream: false,
      },
    );

    expect(response.status).toBe(200);

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        content: string;
        role: string;
      }>;
    };

    expect(upstreamBody.messages).toEqual([
      { role: 'system', content: 'first developer' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'later developer' },
      { role: 'system', content: 'existing system' },
      { role: 'user', content: 'after system developer' },
    ]);
  });

  it('keeps the same credential for one conversation id across chat requests', async () => {
    await addCredential({
      bearer_token: 'token-conv-a',
      created_at: Math.floor(Date.now() / 1000),
      first_message_role_to_system: false,
      user_id: 'conversation-a@example.com',
    });
    await addCredential({
      bearer_token: 'token-conv-b',
      created_at: Math.floor(Date.now() / 1000),
      first_message_role_to_system: true,
      user_id: 'conversation-b@example.com',
    });

    const conversationCredentials = (
      await listCredentials()
    ).credentials.filter(
      (credential) =>
        credential.user_id === 'conversation-a@example.com' ||
        credential.user_id === 'conversation-b@example.com',
    );
    const roleAccessKey = await createAccessKey({
      credentialFilenames: conversationCredentials.map((credential) =>
        String(credential.filename),
      ),
      name: 'Conversation Affinity Key',
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(
        makeJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
      );
    });

    const firstResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${roleAccessKey.secret}`,
          'X-Conversation-ID': 'conversation-a',
        },
      }),
      {
        messages: [{ role: 'developer', content: 'keep role stable' }],
        stream: false,
      },
    );
    const secondResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${roleAccessKey.secret}`,
          'X-Conversation-ID': 'conversation-a',
        },
      }),
      {
        messages: [{ role: 'developer', content: 'same conversation' }],
        stream: false,
      },
    );
    const thirdResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${roleAccessKey.secret}`,
          'X-Conversation-ID': 'conversation-b',
        },
      }),
      {
        messages: [{ role: 'developer', content: 'different conversation' }],
        stream: false,
      },
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(thirdResponse.status).toBe(200);

    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        content: string;
        role: string;
      }>;
    };
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        content: string;
        role: string;
      }>;
    };
    const thirdBody = JSON.parse(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        content: string;
        role: string;
      }>;
    };

    expect(firstBody.messages[0]?.role).toBe('developer');
    expect(secondBody.messages[0]?.role).toBe('developer');
    expect(thirdBody.messages[0]?.role).toBe('system');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aggregates forced upstream streaming responses for non-stream clients', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'json fallback' } }],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"id":"chatcmpl_tool","object":"chat.completion.chunk","created":123,"model":"glm-5.1","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"look","arguments":"{\\"city\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"Shanghai\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":1,"prompt_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('data: not-json\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        }),
      );

    const jsonFallback = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect((await jsonFallback.json()).choices[0].message.content).toBe(
      'json fallback',
    );

    const aggregated = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'use tools' }],
      },
    );
    const aggregatedPayload = await aggregated.json();
    expect(aggregatedPayload.object).toBe('chat.completion');
    expect(aggregatedPayload.choices[0].finish_reason).toBe('tool_calls');
    expect(aggregatedPayload.choices[0].message.content).toBeNull();
    expect(aggregatedPayload.choices[0].message.tool_calls[0].id).toBe(
      'call_1',
    );
    expect(
      aggregatedPayload.choices[0].message.tool_calls[0].function.name,
    ).toBe('lookup');
    expect(
      aggregatedPayload.choices[0].message.tool_calls[0].function.arguments,
    ).toBe('{"city":"Shanghai"}');
    expect(aggregatedPayload.choices[0].message.tool_calls).toHaveLength(1);

    const malformed = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'bad stream' }],
      },
    );
    expect(malformed.status).toBe(502);
  });

  it('preserves response_format and separates repeated upstream tool indexes', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        'data: {"id":"chatcmpl_multi_tool","object":"chat.completion.chunk","created":321,"model":"glm-5.1","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"tooluse_weather","type":"function","function":{"name":"look","arguments":"{\\"city\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"Shanghai\\"}"}},{"index":0,"id":"tooluse_news","type":"function","function":{"name":"search","arguments":"{\\"topic\\":\\"news\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":3,"prompt_tokens":4,"total_tokens":7}}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const aggregated = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'use tools twice' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'tool_plan',
          },
        },
      },
    );
    const aggregatedPayload = await aggregated.json();
    const forwardedBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      response_format?: {
        type?: string;
        json_schema?: {
          name?: string;
        };
      };
    };

    expect(forwardedBody.response_format?.type).toBe('json_schema');
    expect(forwardedBody.response_format?.json_schema?.name).toBe('tool_plan');
    expect(aggregatedPayload.choices[0].message.tool_calls).toHaveLength(2);
    expect(aggregatedPayload.choices[0].message.tool_calls[0].id).toBe(
      'call_weather',
    );
    expect(aggregatedPayload.choices[0].message.tool_calls[1].id).toBe(
      'call_news',
    );
    expect(
      aggregatedPayload.choices[0].message.tool_calls[0].function.arguments,
    ).toBe('{"city":"Shanghai"}');
    expect(
      aggregatedPayload.choices[0].message.tool_calls[1].function.arguments,
    ).toBe('{"topic":"news"}');
  });

  it('covers responses message mapping, tool call mapping, and malformed sse handling', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          'data: {"id":"chatcmpl_unit_1","object":"chat.completion.chunk","choices":[{"delta":{"content":"message "}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'tooluse_weather',
                    type: 'function',
                    function: {
                      name: 'lookup_weather',
                      arguments: '{"city":"Shanghai"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            completion_tokens: 1,
            prompt_tokens: 2,
            total_tokens: 3,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'tool result received' } }],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tooluse_weather","type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tooluse_weather","function":{"arguments":"Shanghai\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"lookup_weather","arguments":"{\\"city\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":1,"type":"function","function":{"name":"lookup_news","arguments":"{\\"topic\\":\\""}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Shanghai\\"}"}}]}}]\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"tech\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response('data: not-json\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        }),
      );

    const messagesResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        messages: [{ role: 'user', content: [{ text: 'hello' }] }],
        model: 'gpt-5.5',
      },
    );
    const messagesPayload = await messagesResponse.json();
    expect(messagesPayload.output_text).toBe('message answer');

    const toolCallResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'call a tool',
        model: 'gpt-5.5',
      },
    );
    const toolCallPayload = await toolCallResponse.json();
    expect(toolCallPayload.output_text).toBe('');
    expect(toolCallPayload.output).toHaveLength(1);
    expect(toolCallPayload.output[0].type).toBe('function_call');
    expect(toolCallPayload.output[0].call_id).toBe('call_weather');
    expect(toolCallPayload.output[0].name).toBe('lookup_weather');
    expect(toolCallPayload.output[0].arguments).toBe('{"city":"Shanghai"}');

    const followUpResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        previous_response_id: toolCallPayload.id,
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_weather',
            output: { temperature: 30 },
          },
        ],
        model: 'gpt-5.5',
      },
    );
    expect((await followUpResponse.json()).output_text).toBe(
      'tool result received',
    );

    const followUpBody = JSON.parse(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_call_id?: string;
        tool_calls?: Array<{
          function: {
            name: string;
            arguments: string;
          };
        }>;
      }>;
    };
    expect(followUpBody.messages[1]?.role).toBe('assistant');
    expect(followUpBody.messages[1]?.tool_calls?.[0]?.function.name).toBe(
      'lookup_weather',
    );
    expect(followUpBody.messages[1]?.tool_calls?.[0]?.function.arguments).toBe(
      '{"city":"Shanghai"}',
    );
    expect(followUpBody.messages[2]?.role).toBe('tool');
    expect(followUpBody.messages[2]?.tool_call_id).toBe('call_weather');
    expect(followUpBody.messages[2]?.content).toBe('{"temperature":30}');

    const streamToolCallResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream a tool call',
        model: 'gpt-5.5',
        stream: true,
      },
    );
    const streamToolCallText = await streamToolCallResponse.text();
    expect(streamToolCallText).toContain('response.output_item.added');
    expect(streamToolCallText).toContain(
      'response.function_call_arguments.delta',
    );
    expect(streamToolCallText).toContain('response.output_item.done');
    expect(streamToolCallText).toContain('"call_id":"call_weather"');

    const streamIndexedToolCallResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream two indexed tool calls',
        model: 'gpt-5.5',
        stream: true,
      },
    );
    const streamIndexedToolCallText =
      await streamIndexedToolCallResponse.text();
    expect(streamIndexedToolCallText).toContain('lookup_weather');
    expect(streamIndexedToolCallText).toContain('lookup_news');
    expect(
      streamIndexedToolCallText.match(/response\.output_item\.added/g)?.length,
    ).toBe(4);
    expect(
      streamIndexedToolCallText.match(/response\.output_item\.done/g)?.length,
    ).toBe(4);

    const streamResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: [
          {
            type: 'function_call',
            name: 'lookup',
            arguments: '{"city":"Shanghai"}',
          },
          {
            type: 'function_call_output',
            output: { temperature: 30 },
          },
        ],
        model: 'gpt-5.5',
        stream: true,
      },
    );
    expect(await streamResponse.text()).toContain('response.error');
  });

  it('maps mcp tool calls back to responses mcp items', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'tooluse_mcp_docs',
                    type: 'function',
                    function: {
                      name: 'mcp_tool',
                      arguments: '{"query":"docs"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'mcp tool result received' } }],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tooluse_mcp_docs","type":"function","function":{"name":"mcp_tool","arguments":"{\\"query\\":\\"docs\\"}"}}]}}]}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      );

    const tools = [
      {
        type: 'mcp',
        server_label: 'docs-svc',
        name: 'mcp_tool',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ];

    const toolCallResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'call mcp tool',
        model: 'gpt-5.5',
        tools,
      },
    );
    const toolCallPayload = await toolCallResponse.json();
    expect(toolCallPayload.output).toHaveLength(1);
    expect(toolCallPayload.output[0]).toMatchObject({
      type: 'mcp_call',
      call_id: 'call_mcp_docs',
      name: 'mcp_tool',
      arguments: '{"query":"docs"}',
      server_label: 'docs-svc',
    });

    const followUpResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        previous_response_id: toolCallPayload.id,
        input: [
          {
            type: 'mcp_call_output',
            call_id: 'call_mcp_docs',
            output: { ok: true },
          },
        ],
        model: 'gpt-5.5',
      },
    );
    expect((await followUpResponse.json()).output_text).toBe(
      'mcp tool result received',
    );

    const followUpBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_call_id?: string;
        tool_calls?: Array<{
          function: {
            name: string;
            arguments: string;
          };
        }>;
      }>;
    };
    const assistantToolCallMessage = followUpBody.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistantToolCallMessage?.tool_calls?.[0]?.function.name).toBe(
      'docs-svc__mcp_tool',
    );
    expect(
      followUpBody.messages.find((message) => message.role === 'tool'),
    ).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_mcp_docs',
      content: '{"ok":true}',
    });

    const streamResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream mcp tool call',
        model: 'gpt-5.5',
        stream: true,
        tools,
      },
    );
    const streamText = await streamResponse.text();
    expect(streamText).toContain('"type":"mcp_call"');
    expect(streamText).toContain('"server_label":"docs-svc"');
    expect(streamText).toContain('response.output_item.done');
  });

  it('maps direct mcp_call input items into upstream assistant tool calls', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        makeJsonResponse({ choices: [{ message: { content: 'done' } }] }),
      );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: [
          {
            type: 'mcp_call',
            call_id: 'mcp_direct_1',
            name: 'mcp_tool',
            arguments: '{"query":"docs"}',
          },
          {
            type: 'mcp_call_output',
            call_id: 'mcp_direct_1',
            output: { ok: true },
          },
        ],
        model: 'gpt-5.5',
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_call_id?: string;
        tool_calls?: Array<{
          id: string;
          function: {
            name: string;
            arguments: string;
          };
        }>;
      }>;
    };

    expect(upstreamBody.messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
    });
    expect(upstreamBody.messages[0]?.tool_calls?.[0]).toMatchObject({
      id: 'mcp_direct_1',
      function: {
        name: 'mcp_tool',
        arguments: '{"query":"docs"}',
      },
    });
    expect(upstreamBody.messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'mcp_direct_1',
      content: '{"ok":true}',
    });
  });

  it('covers responses adapter edge cases for strict tools, generic input items, and passthrough streaming errors', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'done' } }],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse(
          {
            error: { message: 'upstream failed' },
          },
          502,
        ),
      )
      .mockResolvedValueOnce(makeJsonResponse({}))
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'after empty response' } }],
        }),
      );

    const strictToolResult = translateResponsesToolsToChat([
      {
        type: 'function',
        name: 'strict_tool',
        strict: true,
        parameters: { type: 'object', properties: {} },
      },
    ]);
    expect(strictToolResult?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'strict_tool',
        strict: true,
        parameters: { type: 'object', properties: {} },
      },
    });

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: [{ role: 'assistant', content: { text: 'hello' } }],
        model: 'gpt-5.5',
        tools: [
          {
            type: 'function',
            name: 'strict_tool',
            strict: true,
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'strict_tool' },
        },
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{ role: string; content: string }>;
      tool_choice: unknown;
      tools: Array<Record<string, unknown>>;
    };
    expect(upstreamBody.messages[0]).toEqual({
      role: 'assistant',
      content: '{"text":"hello"}',
    });
    expect(upstreamBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'strict_tool' },
    });
    expect(upstreamBody.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'strict_tool',
        strict: true,
        parameters: { type: 'object', properties: {} },
      },
    });

    const streamErrorResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream failure',
        model: 'gpt-5.5',
        stream: true,
      },
    );
    expect(streamErrorResponse.status).toBe(502);

    const emptyResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'empty payload',
        model: 'gpt-5.5',
      },
    );
    const emptyPayload = await emptyResponse.json();
    expect(emptyPayload.output_text).toBe('');
    expect(emptyPayload.output[0]?.type).toBe('message');

    const emptyFollowUpResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        previous_response_id: emptyPayload.id,
        input: 'follow empty response',
        model: 'gpt-5.5',
      },
    );
    expect((await emptyFollowUpResponse.json()).output_text).toBe(
      'after empty response',
    );

    const emptyFollowUpBody = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<unknown>;
      }>;
    };
    expect(emptyFollowUpBody.messages[1]).toEqual({
      role: 'assistant',
      content: '',
    });
  });

  it('records responses passthrough usage from json and sse responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          response: {
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              total_tokens: 6,
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"resp_1"}}',
            '',
            'event: response.completed',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
            '',
          ].join('\n'),
          {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
            },
          },
        ),
      );

    const request = makeNextRequest('http://localhost/v1/responses', {
      method: 'POST',
    });
    const jsonResponse = await proxyResponsesUpstream(request, {
      input: 'hello',
      model: 'gpt-5.5',
    });
    await jsonResponse.text();

    const streamResponse = await proxyResponsesUpstream(request, {
      input: 'hello again',
      model: 'gpt-5.5',
      stream: true,
    });
    await streamResponse.text();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await waitForAsync(async () => {
      expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
        {
          callCount: 2,
          cacheHitTokens: 0,
          model: 'gpt-5.5',
          totalTokens: 14,
        },
      ]);
    });
  });

  it('covers responses passthrough header fallback, raw body passthrough, and upstream errors', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-responses',
      enterprise_id: 'tenant-header',
      responses_passthrough: true,
      user_id: 'responses@example.com',
    });

    const context = await resolveProxyContextByCredentialFilename(
      createdCredential.filename,
    );
    expect(context.auth.bearerToken).toBe('token-responses');

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('not-json', {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'x-codebuddy-usage':
              '{"total_tokens":9,"input_tokens":4,"output_tokens":5}',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('plain body', {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'x-codebuddy-usage':
              '{"total_tokens":11,"input_tokens":5,"output_tokens":6}',
          },
        }),
      )
      .mockRejectedValueOnce('string failure');

    const request = makeNextRequest('http://localhost/v1/responses', {
      method: 'POST',
    });

    const jsonFallback = await proxyResponsesUpstream(
      request,
      {
        input: 'header usage',
      },
      context,
    );
    expect(await jsonFallback.text()).toBe('not-json');

    const rawResponse = await proxyResponsesUpstream(
      request,
      {
        input: 'plain body',
        model: 'gpt-5.5',
      },
      context,
    );
    expect(await rawResponse.text()).toBe('plain body');

    const failedResponse = await proxyResponsesUpstream(
      request,
      {
        input: 'boom',
        model: 'gpt-5.5',
      },
      context,
    );
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.text()).toContain('Unexpected upstream error');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'gpt-5.5',
        totalTokens: 11,
      },
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'glm-5.1',
        totalTokens: 9,
      },
    ]);
  });

  it('covers responses passthrough upstream non-ok and empty stream body branches', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-branches',
      responses_passthrough: true,
      user_id: 'branches@example.com',
    });
    const context = await resolveProxyContextByCredentialFilename(
      createdCredential.filename,
    );

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('upstream denied', {
          status: 429,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'x-codebuddy-usage':
              '{"total_tokens":3,"input_tokens":1,"output_tokens":2}',
          },
        }),
      );

    const request = makeNextRequest('http://localhost/v1/responses', {
      method: 'POST',
    });

    const denied = await proxyResponsesUpstream(
      request,
      { input: 'deny me', model: 'gpt-5.5' },
      context,
    );
    expect(denied.status).toBe(429);
    expect(await denied.text()).toContain('upstream denied');

    const emptyStream = await proxyResponsesUpstream(
      request,
      { input: 'empty stream', model: 'gpt-5.5', stream: true },
      context,
    );
    expect(emptyStream.status).toBe(204);
    expect(await emptyStream.text()).toBe('');

    await waitForAsync(async () => {
      expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
        {
          callCount: 1,
          cacheHitTokens: 0,
          model: 'gpt-5.5',
          totalTokens: 3,
        },
      ]);
    });
  });

  it('does not locally reject previous_response_id for passthrough responses', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-passthrough-follow-up',
      responses_passthrough: true,
      user_id: 'passthrough-follow-up@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [createdCredential.filename],
      name: 'Passthrough Follow-up Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({
        id: 'resp_upstream',
        object: 'response',
        output_text: 'continued upstream',
      }),
    );

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKey.secret}`,
        },
      }),
      {
        input: 'continue remotely',
        model: 'gpt-5.5',
        previous_response_id: 'resp_from_upstream',
      },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
        .previous_response_id,
    ).toBe('resp_from_upstream');
  });

  it('covers proxy context helpers for saved credentials', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-from-bearer-token',
      first_message_role_to_system: true,
      user_id: 'helper@example.com',
    });

    const credentialRecord = await resolveCredentialForRequest({
      allowedCredentialFilenames: [createdCredential.filename],
    });
    expect(credentialRecord?.filename).toBe(createdCredential.filename);

    if (!credentialRecord) {
      throw new Error('Expected saved credential record');
    }

    const created = createProxyContextFromCredential(credentialRecord);
    expect(created.auth.bearerToken).toBe('token-from-bearer-token');
    expect(created.preferences.firstMessageRoleToSystem).toBe(true);
    expect(created.accessKeyId).toBeNull();

    const resolved = await resolveProxyContextByCredentialFilename(
      createdCredential.filename,
    );
    expect(resolved.credentialFilename).toBe(createdCredential.filename);
    expect(resolved.auth.userId).toBe('helper@example.com');

    const expiredCredential = await addCredential({
      bearer_token: 'token-expired-helper',
      created_at: 1,
      expires_in: 1,
      user_id: 'expired-helper@example.com',
    });
    await expect(
      resolveProxyContextByCredentialFilename(expiredCredential.filename, {
        requireEligible: true,
      }),
    ).rejects.toThrow('Selected credential was not found');

    expect(
      createProxyContextFromCredential({
        data: {
          access_token: 'token-from-access-token',
          user_id: 'access-token@example.com',
        },
        filePath: '/tmp/access-token.json',
        filename: 'access-token.json',
      }).auth.bearerToken,
    ).toBe('token-from-access-token');

    expect(() =>
      createProxyContextFromCredential({
        ...credentialRecord,
        data: {
          user_id: 'missing-token@example.com',
        },
      }),
    ).toThrow('Saved credential does not include a bearer token');
    await expect(
      resolveProxyContextByCredentialFilename('missing.json'),
    ).rejects.toThrow('Selected credential was not found');
  });

  it('stops local responses follow-ups when the pinned credential is no longer eligible', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-local-follow-up',
      responses_passthrough: false,
      user_id: 'local-follow-up@example.com',
    });
    const listedBefore = await listCredentials();
    const targetIndex = listedBefore.credentials.findIndex(
      (credential) => credential.filename === createdCredential.filename,
    );
    const accessKey = await createAccessKey({
      credentialFilenames: [createdCredential.filename],
      name: 'Local Follow-up Key',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'stored locally' } }],
        model: 'gpt-5.5',
      }),
    );

    const firstResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKey.secret}`,
        },
      }),
      {
        input: 'start local session',
        model: 'gpt-5.5',
      },
    );
    const firstPayload = (await firstResponse.json()) as { id: string };

    await updateCredentialByIndex(targetIndex, {
      bearer_token: 'token-local-follow-up',
      expires_in: -1,
      responses_passthrough: false,
      user_id: 'local-follow-up@example.com',
    });

    const followUpResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKey.secret}`,
        },
      }),
      {
        input: 'continue local session',
        previous_response_id: firstPayload.id,
      },
    );

    expect(firstResponse.status).toBe(200);
    expect(followUpResponse.status).toBe(500);
    expect(await followUpResponse.text()).toContain(
      'Selected credential was not found',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updates saved credentials by index and normalizes string boolean flags', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-original',
      first_message_role_to_system: false,
      responses_passthrough: false,
      user_id: 'update@example.com',
    });

    await expect(
      updateCredentialByIndex(99, {
        bearer_token: 'missing',
      }),
    ).rejects.toThrow('Invalid credential index');

    const listedBefore = await listCredentials();
    const targetIndex = listedBefore.credentials.findIndex(
      (credential) => credential.filename === createdCredential.filename,
    );
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    const updated = await updateCredentialByIndex(targetIndex, {
      bearer_token: 'token-updated',
      first_message_role_to_system: 'true' as unknown as boolean,
      responses_passthrough: 'false' as unknown as boolean,
      user_id: 'update@example.com',
    });
    expect(updated.filename).toBe(createdCredential.filename);
    expect(updated.success).toBe(true);

    const resolved = await resolveProxyContextByCredentialFilename(
      createdCredential.filename,
    );
    expect(resolved.auth.bearerToken).toBe('token-updated');
    expect(resolved.preferences.firstMessageRoleToSystem).toBe(true);
    expect(resolved.preferences.responsesPassthrough).toBe(false);
  });

  it('returns models in both OpenAI-compatible and admin-friendly shapes', async () => {
    const payload = (await (await getModelsResponse()).json()) as {
      data: Array<Record<string, unknown>>;
      models: Array<Record<string, unknown>>;
    };

    expect(payload.data.length).toBeGreaterThan(0);
    expect(payload.models).toEqual(payload.data);
    expect(payload.data[0]).toEqual(
      expect.objectContaining({
        created: 0,
        display_name: expect.any(String),
        id: expect.any(String),
        object: 'model',
        owned_by: 'codebuddy',
        slug: expect.any(String),
      }),
    );
  });

  it('keeps empty streamed assistant content for previous_response_id follow-ups', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'after empty stream' } }],
        }),
      );

    const streamResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'empty stream',
        model: 'gpt-5.5',
        stream: true,
      },
    );
    const streamText = await streamResponse.text();
    const previousResponseId = streamText.match(/"id":"(resp_[^"]+)"/)?.[1];
    expect(previousResponseId).toBeTruthy();

    const followUpResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        previous_response_id: previousResponseId,
        input: 'follow empty stream',
        model: 'gpt-5.5',
      },
    );
    expect((await followUpResponse.json()).output_text).toBe(
      'after empty stream',
    );

    const followUpBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
      }>;
    };
    expect(followUpBody.messages[1]).toEqual({
      role: 'assistant',
      content: '',
    });
  });

  it('streams split mcp tool names, pending argument deltas, and reasoning deltas', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'event: ping\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_docs","index":0}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"mcp_","arguments":"{\\"query\\":\\""}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"reasoning_content":"thinking","tool_calls":[{"index":0,"function":{"name":"tool","arguments":"docs\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const streamResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream split mcp tool call',
        model: 'gpt-5.5',
        stream: true,
        tools: [
          {
            type: 'mcp',
            server_label: 'docs-svc',
            name: 'mcp_tool',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
    );

    const streamText = await streamResponse.text();
    expect(streamText).toContain('response.reasoning_text.delta');
    expect(streamText).toContain('"type":"mcp_call"');
    expect(streamText).toContain('"server_label":"docs-svc"');
    expect(streamText).toContain('response.mcp_call_arguments.delta');
    expect(streamText).toContain('response.function_call_arguments.delta');
    expect(streamText).toContain('"arguments":"{\\"query\\":\\"docs\\"}"');
    expect(streamText).not.toContain('"name":"function"');
  });

  it('keeps buffering tool names that exactly match a shorter prefix tool', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_search","index":0,"type":"function","function":{"name":"search","arguments":"{\\"query\\":\\""}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_docs","arguments":"docs\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
          'data: [DONE]\n\n',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const streamResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'stream shared prefix tool call',
        model: 'gpt-5.5',
        stream: true,
        tools: [
          {
            type: 'function',
            name: 'search',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
          {
            type: 'mcp',
            server_label: 'docs-svc',
            name: 'search_docs',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
    );

    const streamText = await streamResponse.text();
    expect(streamText).toContain('"type":"mcp_call"');
    expect(streamText).toContain('"name":"search_docs"');
    expect(streamText).toContain(
      '"name":"search","arguments":"","status":"in_progress"',
    );
  });

  it('covers auth api fallback branches', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({ code: 1, msg: 'bad start' }, 200),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({ code: 9, msg: 'bad poll' }, 200),
      );

    expect((await (await startCodeBuddyAuth()).json()).success).toBe(false);
    expect((await (await pollCodeBuddyAuth('')).json()).error).toBe(
      'missing_parameters',
    );
    expect((await (await pollCodeBuddyAuth('state-1')).json()).error).toBe(
      'auth_error',
    );
    expect(
      (
        await getAuthCallbackResponse(
          new URLSearchParams('error=denied'),
        ).json()
      ).error,
    ).toBe('denied');
  });

  it('covers successful auth flow with JWT token decoding', async () => {
    expect((await deleteCredentialByIndex(0)).success).toBe(true);

    // Build a fake JWT payload with enterprise/tenant/user info.
    const jwtPayload = {
      email: 'user@example.com',
      enterprise_id: 'ent-123',
      tenant_id: 'tenant-456',
      sid: 'session-789',
      name: 'Test User',
      preferred_username: 'testuser',
    };
    const encodedPayload = Buffer.from(JSON.stringify(jwtPayload)).toString(
      'base64url',
    );
    const fakeJwt = `header.${encodedPayload}.signature`;

    vi.spyOn(globalThis, 'fetch')
      // startCodeBuddyAuth success
      .mockResolvedValueOnce(
        makeJsonResponse({
          code: 0,
          data: {
            state: 'state-abc',
            authUrl: 'https://example.com/auth',
          },
        }),
      )
      // pollCodeBuddyAuth success
      .mockResolvedValueOnce(
        makeJsonResponse({
          code: 0,
          data: {
            accessToken: fakeJwt,
            expiresIn: 3600,
            refreshToken: 'refresh-tok',
            scope: 'read',
            sessionState: 'sess-1',
            tokenType: 'Bearer',
            domain: 'example.com',
            enterpriseId: 'ent-123',
            tenantId: 'tenant-456',
          },
        }),
      );

    const startResult = (await (await startCodeBuddyAuth()).json()) as Record<
      string,
      unknown
    >;
    expect(startResult.success).toBe(true);
    expect(startResult.auth_state).toBe('state-abc');
    expect(startResult.verification_uri_complete).toBe(
      'https://example.com/auth',
    );

    const pollResult = (await (
      await pollCodeBuddyAuth('state-abc')
    ).json()) as Record<string, unknown>;
    expect(pollResult.access_token).toBe(fakeJwt);
    expect(pollResult.saved).toBe(true);
    expect(pollResult.user_info).toMatchObject({
      email: 'user@example.com',
      name: 'Test User',
      preferred_username: 'testuser',
    });

    // The credential should have been saved with enterprise/tenant info.
    const savedCredential = (await listCredentials()).credentials.find(
      (credential) => credential.tenant_id === 'tenant-456',
    );
    expect(savedCredential?.tenant_id).toBe('tenant-456');

    const credInfo = await getCurrentCredentialInfo();
    expect(credInfo.status).toBe('round_robin');
  });

  it('covers authorization pending and empty token fallbacks', async () => {
    vi.spyOn(globalThis, 'fetch')
      // authorization_pending (code 11217)
      .mockResolvedValueOnce(
        makeJsonResponse({
          code: 11217,
          msg: 'waiting for login',
        }),
      )
      // success with empty bearer token (fallback to unknown user)
      .mockResolvedValueOnce(
        makeJsonResponse({
          code: 0,
          data: {
            accessToken: 'not-a-jwt',
            expiresIn: 0,
            tokenType: 'Bearer',
          },
        }),
      );

    const pendingResult = await (
      await pollCodeBuddyAuth('state-pending')
    ).json();
    expect(pendingResult.error).toBe('authorization_pending');

    const emptyResult = await (await pollCodeBuddyAuth('state-empty')).json();
    expect(emptyResult.access_token).toBe('not-a-jwt');
    expect(emptyResult.saved).toBe(true);
  });

  it('translates responses tools to chat-completions schema before proxying', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'done' } }],
      }),
    );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use a tool',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'function',
            name: 'lookup_weather',
            description: 'Look up weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tools: Array<Record<string, unknown>> };

    expect(upstreamBody.tools).toHaveLength(1);
    expect(upstreamBody.tools[0].type).toBe('function');
    expect(upstreamBody.tools[0].function).toEqual({
      name: 'lookup_weather',
      description: 'Look up weather',
      parameters: { type: 'object', properties: {} },
    });
  });

  it('flattens tools with function semantics into chat function tools', () => {
    const result = translateResponsesToolsToChat([
      { type: 'file_search' },
      { type: 'web_search_preview' },
      {
        type: 'function',
        name: 'lookup_weather',
        parameters: { type: 'object', properties: {} },
      },
      {
        type: 'file_search',
        function: {
          name: 'search_files',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      },
      {
        type: 'web_search_preview',
        name: 'search_web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
      {
        type: 'mcp',
        server_label: 'svc',
        name: 'mcp_tool',
        description: 'Call MCP tool',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
      {
        type: 'namespace',
        name: 'docs',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: 'Lookup docs',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
      {
        type: 'tool_search',
      },
    ]);

    expect(result).toHaveLength(6);
    expect(result?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'lookup_weather',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(result?.[1]).toEqual({
      type: 'function',
      function: {
        name: 'search_files',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    });
    expect(result?.[2]).toEqual({
      type: 'function',
      function: {
        name: 'search_web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    });
    expect(result?.[3]).toEqual({
      type: 'function',
      function: {
        name: 'svc__mcp_tool',
        description: 'Call MCP tool',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    });
    expect(result?.[4]).toEqual({
      type: 'function',
      function: {
        name: 'docs__lookup',
        description: 'Lookup docs',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    });
    expect(result?.[5]).toEqual({
      type: 'function',
      function: {
        name: 'tool_search',
        description:
          'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for tools or connectors to load.',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of tool groups to return.',
            },
          },
          required: ['query'],
        },
      },
    });
  });

  it('translates children namespaces and custom tools into chat function tools', () => {
    const result = translateResponsesToolsToChat([
      {
        type: 'namespace',
        name: 'workspace',
        children: [
          {
            type: 'custom',
            name: 'raw_lookup',
            description: '',
          },
          {
            type: 'function',
            name: 'inspect',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        ],
      },
      {
        type: 'custom',
        name: 'top_level_custom',
      },
      {
        type: 'custom',
        name: '   ',
      },
      {
        type: 'namespace',
        name: '   ',
        children: [{ type: 'function', name: 'ignored' }],
      },
    ]);

    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'raw_lookup',
          description: 'Custom tool raw_lookup',
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Raw string input for the original custom tool.',
              },
            },
            required: ['input'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'workspace__inspect',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'top_level_custom',
          description: 'Custom tool top_level_custom',
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Raw string input for the original custom tool.',
              },
            },
            required: ['input'],
          },
        },
      },
    ]);
  });

  it('returns undefined when only unsupported tool types are provided', () => {
    expect(
      translateResponsesToolsToChat([
        { type: 'file_search' },
        { type: 'image_generation' },
      ]),
    ).toBeUndefined();
  });

  it('maps responses tool_choice object variants to chat-completions shapes', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({
        choices: [{ message: { content: 'done' } }],
      }),
    );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use built-in choice',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'file_search',
            function: {
              name: 'search_files',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: { type: 'file_search', name: 'search_files' },
      },
    );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use mcp choice',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'mcp',
            server_label: 'svc',
            name: 'mcp_tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'mcp', server_label: 'svc', name: 'mcp_tool' },
      },
    );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use auto choice',
        model: 'gpt-5.5',
        tool_choice: { type: 'auto' },
      },
    );

    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use string required choice',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'function',
            name: 'lookup_weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: 'required',
      },
    );

    const firstUpstream = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };
    const secondUpstream = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown; tools: Array<Record<string, unknown>> };
    const thirdUpstream = JSON.parse(
      String((fetchMock.mock.calls[2]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };
    const fourthUpstream = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };

    expect(firstUpstream.tool_choice).toEqual({
      type: 'function',
      function: { name: 'search_files' },
    });
    expect(secondUpstream.tool_choice).toEqual({
      type: 'function',
      function: { name: 'svc__mcp_tool' },
    });
    expect(secondUpstream.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'svc__mcp_tool',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(thirdUpstream.tool_choice).toBe('auto');
    expect(fourthUpstream.tool_choice).toBe('required');
  });

  it('accepts mcp tools, while still rejecting invalid tool_choice before proxying', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        makeJsonResponse({ choices: [{ message: { content: 'done' } }] }),
      );

    const mcpToolsResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use mcp tool',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'mcp',
            server_label: 'svc',
            name: 'mcp_tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    );
    const mcpChoiceResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use mcp tool choice',
        model: 'gpt-5.5',
        tools: [
          {
            type: 'mcp',
            server_label: 'svc',
            name: 'mcp_tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'mcp', server_label: 'svc', name: 'mcp_tool' },
      },
    );
    const invalidChoiceResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use invalid tool choice',
        model: 'gpt-5.5',
        tool_choice: { type: 'file_search' },
      },
    );
    const missingToolChoiceResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'use missing named tool choice',
        model: 'gpt-5.5',
        tool_choice: { type: 'file_search', name: 'search_files' },
      },
    );
    const requiredUnsupportedToolsResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'require unsupported tools',
        model: 'gpt-5.5',
        tools: [{ type: 'file_search' }],
        tool_choice: { type: 'required' },
      },
    );
    const stringRequiredUnsupportedToolsResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'require unsupported tools by string',
        model: 'gpt-5.5',
        tools: [{ type: 'file_search' }],
        tool_choice: 'required',
      },
    );

    expect(mcpToolsResponse.status).toBe(200);
    expect(mcpChoiceResponse.status).toBe(200);
    expect(invalidChoiceResponse.status).toBe(400);
    expect(missingToolChoiceResponse.status).toBe(400);
    expect(requiredUnsupportedToolsResponse.status).toBe(400);
    expect(stringRequiredUnsupportedToolsResponse.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts mcp input items and rewrites them into follow-up chat messages', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        makeJsonResponse({ choices: [{ message: { content: 'done' } }] }),
      );

    const mcpOutputResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: [
          {
            type: 'mcp_call_output',
            call_id: 'mcp_1',
            output: { ok: true },
          },
        ],
        model: 'gpt-5.5',
      },
    );
    const mcpApprovalResponse = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: [
          {
            type: 'mcp_approval_response',
            output: { approved: true },
          },
        ],
        model: 'gpt-5.5',
      },
    );

    expect(mcpOutputResponse.status).toBe(200);
    expect(mcpApprovalResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const mcpOutputBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string;
        tool_call_id?: string;
      }>;
    };
    const mcpApprovalBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string;
      }>;
    };
    const mcpApprovalUserMessage = mcpApprovalBody.messages.find(
      (message) => message.role === 'user',
    );

    expect(mcpOutputBody.messages[0]).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'mcp_1',
    });
    expect(mcpApprovalUserMessage).toEqual({
      role: 'user',
      content: '{"type":"mcp_approval_response","output":{"approved":true}}',
    });
  });

  it('maps bare session_id and originator headers to x- prefixed names', () => {
    const headers = new Headers({
      session_id: 'sess-123',
      originator: 'codex',
      'x-request-id': 'req-456',
    });

    const result = getRequestHeaderMap(headers);

    expect(result['x-session-id']).toBe('sess-123');
    expect(result['x-originator']).toBe('codex');
    expect(result['x-request-id']).toBe('req-456');
    expect(result['session_id']).toBeUndefined();
    expect(result['originator']).toBeUndefined();
  });

  it('coerces settings values to strings', async () => {
    await updateSettings({ CODEBUDDY_LOG_LEVEL: true });

    const config = await getActiveConfig();

    expect(config.CODEBUDDY_LOG_LEVEL).toBe('true');
  });

  it('preserves settings from concurrent updates', async () => {
    await Promise.all([
      updateSettings({ CODEBUDDY_AUTH_MODE: 'token' }),
      updateSettings({ CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'admin.example.com' }),
    ]);

    await expect(getActiveConfig()).resolves.toMatchObject({
      CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'admin.example.com',
      CODEBUDDY_AUTH_MODE: 'token',
    });
  });
});
