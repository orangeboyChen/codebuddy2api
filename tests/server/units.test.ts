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
  getModelsByCredential,
  getModelsForCredential,
  getModelsForCredentials,
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
  readCredentialRecords,
  resetCredentialRuntimeState,
  resolveCredentialForRequest,
  resumeAutoRotation,
  selectCredential,
  toggleAutoRotation,
  updateCredentialSupportedModels,
  updateCredentialByIndex,
} from '@/lib/server/domain/credentials';
import { refreshMissingCredentialModels } from '@/lib/server/domain/credential-models';
import {
  handleResponsesRequest,
  resetResponseSessions,
  translateResponsesToolsToChat,
} from '@/lib/server/proxy/responses';
import {
  getActiveConfig,
  getDefaultModel,
  updateSettings,
} from '@/lib/server/domain/config';
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
    vi.clearAllMocks();
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
    expect(trace.requestKey).toMatch(/^cb2_requ\*+7890$/);
    expect(trace.upstreamRequest?.headers.authorization).toMatch(
      /^upstream\*+oken$/,
    );
    expect(trace.upstreamRequest?.headers['x-api-key']).toMatch(
      /^upstream\*+7890$/,
    );
    expect(trace.upstreamRequest?.headers['x-user-id']).toMatch(
      /^upstream\*+7890$/,
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

    const modelOneCredential = (await readCredentialRecords()).find(
      (record) => record.data.user_id === 'one@example.com',
    );
    const modelTwoCredential = (await readCredentialRecords()).find(
      (record) => record.data.user_id === 'two@example.com',
    );
    await updateCredentialSupportedModels(modelOneCredential?.filename ?? '', [
      'glm-one',
    ]);
    await updateCredentialSupportedModels(modelTwoCredential?.filename ?? '', [
      'glm-two',
    ]);
    expect(await getDefaultModel()).toBe('glm-one');
    expect(
      (
        await resolveCredentialForRequest({
          allowedCredentialFilenames: [
            modelOneCredential?.filename ?? '',
            modelTwoCredential?.filename ?? '',
          ],
          model: 'glm-two',
        })
      )?.filename,
    ).toBe(modelTwoCredential?.filename);

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

  it('refreshes only credentials missing saved models', async () => {
    const refreshState = globalThis as typeof globalThis & {
      __codebuddy2apiCredentialModelRefresh__?: Promise<void>;
    };
    delete refreshState.__codebuddy2apiCredentialModelRefresh__;

    const first = await addCredential({ bearer_token: 'token-first' });
    const second = await addCredential({ bearer_token: 'token-second' });
    const existing = await addCredential({ bearer_token: 'token-existing' });
    await updateCredentialSupportedModels(existing.filename, ['glm-existing']);
    const defaultCredential = (await readCredentialRecords()).find(
      (record) => record.data.bearer_token === 'default-test-token',
    );
    await updateCredentialSupportedModels(defaultCredential?.filename ?? '', [
      'glm-default',
    ]);
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              agents: [{ models: ['glm-5.1'], name: 'cli' }],
              models: [{ id: 'glm-5.1', name: 'GLM 5.1' }],
            },
          }),
        ),
      )
      .mockRejectedValueOnce(new Error('Upstream unavailable'))
      .mockRejectedValue(new Error('Unexpected model discovery request'));

    await refreshMissingCredentialModels();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const records = await readCredentialRecords();
    const refreshedModels = [first.filename, second.filename].map(
      (filename) =>
        records.find((record) => record.filename === filename)?.data
          .supported_models,
    );
    expect(refreshedModels).toContain('glm-5.1');
    expect(refreshedModels).toContain(undefined);

    delete refreshState.__codebuddy2apiCredentialModelRefresh__;
  });

  it('does not block startup when credential model refresh cannot read storage', async () => {
    const refreshState = globalThis as typeof globalThis & {
      __codebuddy2apiCredentialModelRefresh__?: Promise<void>;
    };
    delete refreshState.__codebuddy2apiCredentialModelRefresh__;
    process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
    process.env.CODEBUDDY_STORAGE_PG_URL = 'postgres://example.test/codebuddy';
    resetStorageRuntime();
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await expect(refreshMissingCredentialModels()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      '[CodeBuddy2API] Unable to refresh missing credential models',
      expect.any(Error),
    );

    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    resetStorageRuntime();
    delete refreshState.__codebuddy2apiCredentialModelRefresh__;
  });

  it('persists usage history under file storage and preserves historical filters', async () => {
    const now = new Date('2026-07-11T12:30:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await addCredential({
      bearer_token: 'token-a',
      supported_models: 'glm-4.7,glm-5.1',
    });

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
    expect(analytics.callSeries[0]?.color).toBe('#ea580c');

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
    expect(filtered.rangeSummary.callCount).toBe(1);
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
    await enqueueUpstreamResponseSnapshot(
      trace,
      makeJsonResponse({
        id: 'resp_upstream',
      }),
    ).text();
    finalizeDebugTrace(
      trace,
      new Response('completed', {
        headers: {
          'Content-Type': 'text/plain',
        },
        status: 202,
      }),
    );

    await vi.waitFor(
      async () => {
        expect(await listDebugLogs()).toHaveLength(1);
      },
      { timeout: 2_000 },
    );

    expect((await listDebugLogs())[0]).toMatchObject({
      error: 'upstream warning',
      requestBody: {
        model: 'gpt-5.5',
      },
      requestKey: 'credenti***json',
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

    expect(await hasAccessKeys()).toBe(true);
    expect(await findAccessKeyById('valid-id')).toMatchObject({
      credentialFilenames: [],
    });
    expect(await findAccessKeyBySecret('shortsecret')).toMatchObject({
      id: 'valid-id',
    });
    expect(await getAccessKeySecret('valid-id')).toMatchObject({
      id: 'valid-id',
    });
    expect(await listStoredAccessKeys()).toHaveLength(1);
    expect((await listAccessKeys()).access_keys).toHaveLength(1);

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
    const emptyKey = await createAccessKey({
      credentialFilenames: ['   '],
      name: 'Missing Credentials',
    });
    expect(emptyKey.access_key.credentialFilenames).toEqual([]);

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
    expect(created.access_key.maskedSecret).toContain('****');

    await expect(
      updateAccessKey(created.access_key.id, {
        credentialFilenames: [firstCredential.filename],
        name: '   ',
      }),
    ).rejects.toThrow('Access key name is required');
    await expect(
      updateAccessKey(created.access_key.id, {
        credentialFilenames: [],
        name: 'No Credentials',
      }),
    ).resolves.toMatchObject({ credentialFilenames: [] });
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
    expect(await findAccessKeyById(singleKey.access_key.id)).toMatchObject({
      credentialFilenames: [],
    });
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
      expect.objectContaining({
        credentialFilenames: [],
        id: 'stale-only',
      }),
    ]);
    expect(await hasAccessKeys()).toBe(true);
    expect(await findAccessKeyBySecret('cb2_stalesecret')).toMatchObject({
      credentialFilenames: [],
      id: 'stale-only',
    });

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'access-keys.json'), 'utf8'),
    ) as { accessKeys: Array<{ credentialFilenames: string[]; id: string }> };
    expect(persisted.accessKeys).toHaveLength(2);
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
    expect(upstreamHeaders.get('Authorization')).toBe('Bearer token-a');
    expect(upstreamHeaders.get('User-Agent')).toBe(
      'CLI/2.137.1 CodeBuddy/2.137.1',
    );
    expect(upstreamHeaders.get('X-IDE-Version')).toBe('2.137.1');
    expect(upstreamHeaders.get('X-Product-Version')).toBe('2.137.1');
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

  it('uses the Responses upstream protocol for Chat Completions requests', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-token',
        upstream_protocol: 'responses',
        user_id: 'responses@example.com',
      },
      filePath: '/tmp/responses.json',
      filename: 'responses.json',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        created_at: 123,
        id: 'resp_123',
        output: [],
        output_text: 'hello from responses',
        usage: {
          input_tokens: 2,
          input_tokens_details: {
            cached_tokens: 1,
            cache_creation_tokens: 1,
          },
          output_tokens: 3,
          total_tokens: 5,
        },
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [
          { content: 'Follow instructions', role: 'system' },
          {
            content: [
              { text: 'Say hello', type: 'text' },
              {
                image_url: { detail: 'high', url: 'https://example.com/a.png' },
                type: 'image_url',
              },
            ],
            role: 'user',
          },
        ],
        model: 'hy3',
        reasoning_effort: 'high',
        parallel_tool_calls: false,
        response_format: {
          json_schema: {
            name: 'answer',
            schema: { properties: {}, type: 'object' },
            strict: true,
          },
          type: 'json_schema',
        },
        tool_choice: {
          function: { name: 'lookup_weather' },
          type: 'function',
        },
        temperature: 0.2,
        top_p: 0.8,
        tools: [
          {
            function: {
              name: 'lookup_weather',
              parameters: { properties: {}, type: 'object' },
            },
            type: 'function',
          },
        ],
      },
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [
        { message: { content: 'hello from responses', role: 'assistant' } },
      ],
      model: 'hy3',
      object: 'chat.completion',
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://copilot.tencent.com/responses',
    );
    const upstreamHeaders = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
    );
    expect(upstreamHeaders.get('User-Agent')).toBe(
      'CLI/2.137.1 CodeBuddy/2.137.1',
    );
    expect(upstreamHeaders.get('X-IDE-Name')).toBe('CLI');
    expect(upstreamHeaders.get('X-IDE-Version')).toBe('2.137.1');
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({
      input: [
        {
          content: [
            { text: 'Say hello', type: 'input_text' },
            {
              detail: 'high',
              image_url: 'https://example.com/a.png',
              type: 'input_image',
            },
          ],
          role: 'user',
        },
      ],
      instructions: 'Follow instructions',
      model: 'hy3',
      parallel_tool_calls: false,
      reasoning: { effort: 'high' },
      stream: false,
      temperature: 0.2,
      text: {
        format: {
          name: 'answer',
          schema: { properties: {}, type: 'object' },
          strict: true,
          type: 'json_schema',
        },
      },
      tool_choice: { name: 'lookup_weather', type: 'function' },
      tools: [
        {
          name: 'lookup_weather',
          parameters: { properties: {}, type: 'object' },
          type: 'function',
        },
      ],
      top_p: 0.8,
    });
    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 1,
        model: 'hy3',
        totalTokens: 5,
      },
    ]);
    const usageStore = JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'usage-history.json'), 'utf8'),
    ) as { events: Array<Record<string, unknown>> };
    expect(usageStore.events[0]).toMatchObject({
      cacheCreationTokens: 1,
      cacheReadTokens: 1,
    });
  });

  it('covers Responses upstream compatibility input variants', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-compatibility-token',
        upstream_protocol: 'responses',
        user_id: 'responses-compatibility@example.com',
      },
      filePath: '/tmp/responses-compatibility.json',
      filename: 'responses-compatibility.json',
    });
    const upstreamPayload = {
      incomplete_details: { reason: 'content_filter' },
      output: [
        null,
        1,
        { type: 'other' },
        { type: 'function_call' },
        { content: null, type: 'message' },
        {
          content: [
            null,
            1,
            { text: 1, type: 'output_text' },
            { text: 'from output', type: 'output_text' },
          ],
          type: 'message',
        },
        {
          content: [{ text: 'summary content' }],
          summary: [null, 1, { text: 1 }, { text: 'summary' }],
          type: 'reasoning',
        },
      ],
      status: 'incomplete',
      usage: { input_tokens: 2, output_tokens: 3 },
    };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => makeJsonResponse(upstreamPayload));
    const request = async (
      body: Parameters<typeof proxyChatCompletions>[1],
    ) => {
      const response = await proxyChatCompletions(
        makeNextRequest('http://localhost/v1/chat/completions', {
          method: 'POST',
        }),
        body,
        context,
      );
      await response.text();
      return response.status;
    };

    expect(
      await request({
        messages: [
          { content: null, role: 'system' },
          {
            content: [
              'plain',
              null,
              { text: null },
              { unknown: true },
              {
                image_url: 'https://example.com/string.png',
                type: 'image_url',
              },
              {
                image_url: { url: 'https://example.com/object.png' },
                type: 'image_url',
              },
              {
                image_url: 'https://example.com/input.png',
                type: 'input_image',
              },
              { text: 'text part' },
              { image_url: { url: 1 }, type: 'image_url' },
            ],
            role: 'user',
          },
        ],
        model: 'hy3',
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        tool_choice: 'auto',
        tools: [
          null,
          1,
          { name: 'direct_tool' },
          { function: { description: 'missing name' }, type: 'function' },
        ],
      }),
    ).toBe(200);

    expect(
      await request({
        messages: [
          {
            content: null,
            role: 'assistant',
            tool_calls: [
              null,
              1,
              { function: {} },
              { function: { name: 'lookup' } },
            ],
          },
          { content: { result: true }, role: 'tool', tool_call_id: 'call_1' },
        ],
        model: 'hy3',
        response_format: 1,
        thinking: { budget_tokens: 1_000, type: 'adaptive' },
        tool_choice: 1,
      }),
    ).toBe(200);

    expect(
      await request({
        messages: [
          {
            content: 'assistant text',
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{}', name: 'lookup' },
                id: 'call_lookup',
              },
            ],
          },
        ],
        model: 'hy3',
        response_format: {
          json_schema: { description: 'schema', name: 'answer' },
          type: 'json_schema',
        },
        thinking: { budget_tokens: 5_000, type: 'enabled' },
        tool_choice: { name: 'lookup', type: 'function' },
      }),
    ).toBe(200);

    expect(
      await request({
        messages: [{ content: undefined, role: 'user' }],
        model: 'hy3',
        response_format: { json_schema: {}, type: 'json_schema' },
        thinking: { budget_tokens: 10_000, type: 'adaptive' },
        tool_choice: { type: 'function' },
      }),
    ).toBe(200);

    expect(
      await request({
        messages: [{ content: 'reason', role: 'user' }],
        model: 'hy3',
        reasoning_effort: 'medium',
        response_format: { type: 'text' },
        thinking: { type: 'enabled' },
        tool_choice: { type: 'required' },
      }),
    ).toBe(200);

    expect(
      await request({
        messages: [{ content: 'unsupported', role: 'user' }],
        model: 'hy3',
        thinking: { type: 'unknown' },
      }),
    ).toBe(400);
    expect(
      await request({
        frequency_penalty: 0,
        messages: [{ content: 'unsupported', role: 'user' }],
        model: 'hy3',
        presence_penalty: 0,
      }),
    ).toBe(400);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_object' } },
      tool_choice: 'auto',
    });
  });

  it('covers Responses payload fallback and stop variants', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-payload-token',
        upstream_protocol: 'responses',
        user_id: 'responses-payload@example.com',
      },
      filePath: '/tmp/responses-payload.json',
      filename: 'responses-payload.json',
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          output: [
            null,
            1,
            { content: null, type: 'message' },
            {
              content: [
                null,
                1,
                { text: 1, type: 'output_text' },
                { text: 'zSTOPaEND', type: 'output_text' },
              ],
              type: 'message',
            },
          ],
          status: 'incomplete',
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          output: [
            {
              arguments: undefined,
              id: 'fc_fallback',
              name: undefined,
              type: 'function_call',
            },
          ],
          output_text: '',
          status: 'completed',
          usage: {},
        }),
      );

    const incompleteResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'fallback', role: 'user' }],
        model: 'hy3',
        stop: ['', 'END', 'STOP'],
      },
      context,
    );
    expect(await incompleteResponse.json()).toMatchObject({
      choices: [
        {
          finish_reason: 'length',
          message: { content: 'z' },
        },
      ],
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 },
    });

    const toolResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'tool fallback', role: 'user' }],
        model: 'hy3',
      },
      context,
    );
    expect(await toolResponse.json()).toMatchObject({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                function: { arguments: '', name: 'function' },
                id: 'fc_fallback',
              },
            ],
          },
        },
      ],
    });
  });

  it('applies Chat stop sequences locally for the Responses upstream', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-options-token',
        upstream_protocol: 'responses',
        user_id: 'responses-options@example.com',
      },
      filePath: '/tmp/responses-options.json',
      filename: 'responses-options.json',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        id: 'resp_stopped',
        output: [],
        output_text: 'beforeENDafter',
        status: 'completed',
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Stop early', role: 'user' }],
        model: 'hy3',
        stop: ['END'],
      },
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'before' },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).not.toHaveProperty('stop');
  });

  it('maps Responses reasoning and semantic failures to Chat', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-reasoning-token',
        upstream_protocol: 'responses',
        user_id: 'responses-reasoning@example.com',
      },
      filePath: '/tmp/responses-reasoning.json',
      filename: 'responses-reasoning.json',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'resp_reasoning',
          output: [
            {
              type: 'reasoning',
              summary: [{ text: 'Reasoning summary', type: 'summary_text' }],
            },
          ],
          output_text: 'answer',
          status: 'completed',
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          error: { code: 'server_error', message: 'model failed' },
          id: 'resp_failed',
          status: 'failed',
        }),
      );

    const reasoningResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Think', role: 'user' }],
        model: 'hy3',
        thinking: { type: 'adaptive' },
      },
      context,
    );
    expect(await reasoningResponse.json()).toMatchObject({
      choices: [
        {
          message: {
            content: 'answer',
            reasoning_content: 'Reasoning summary',
          },
        },
      ],
    });
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({ reasoning: { summary: 'auto' } });

    const failedResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Fail', role: 'user' }],
        model: 'hy3',
      },
      context,
    );
    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.text()).toContain('model failed');
  });

  it('maps Responses content filtering and split stop sequences in streams', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-stream-stop-token',
        upstream_protocol: 'responses',
        user_id: 'responses-stream-stop@example.com',
      },
      filePath: '/tmp/responses-stream-stop.json',
      filename: 'responses-stream-stop.json',
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"beforeEN"}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"Dafter"}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const stoppedResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Stop', role: 'user' }],
        model: 'hy3',
        stop: 'END',
        stream: true,
      },
      context,
    );
    const stoppedText = await stoppedResponse.text();
    expect(stoppedText).toContain('"content":"before"');
    expect(stoppedText).not.toContain('after');
    expect(stoppedText).toContain('"finish_reason":"stop"');

    const filteredResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Filter', role: 'user' }],
        model: 'hy3',
        stream: true,
      },
      context,
    );
    expect(await filteredResponse.text()).toContain(
      '"finish_reason":"content_filter"',
    );
  });

  it('emits Responses usage for Chat streams and preserves it after local stops', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-stream-usage-token',
        upstream_protocol: 'responses',
        user_id: 'responses-stream-usage@example.com',
      },
      filePath: '/tmp/responses-stream-usage.json',
      filename: 'responses-stream-usage.json',
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"normal"}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"beforeENDafter"}\n\n' +
            'data: {"type":"response.output_text.delta","delta":"ignored"}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const normalResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Normal usage', role: 'user' }],
        model: 'hy3',
        stream: true,
        stream_options: { include_usage: true },
      },
      context,
    );
    const normalPayload = await normalResponse.text();
    expect(normalPayload).toContain('"choices":[]');
    expect(normalPayload).toContain(
      '"prompt_tokens":3,"prompt_tokens_details"',
    );
    expect(normalPayload).toContain('"completion_tokens":2');

    const stoppedResponse = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Stopped usage', role: 'user' }],
        model: 'hy3',
        stop: 'END',
        stream: true,
        stream_options: { include_usage: true },
      },
      context,
    );
    const stoppedPayload = await stoppedResponse.text();
    expect(stoppedPayload).toContain('"content":"before"');
    expect(stoppedPayload).not.toContain('after');
    expect(stoppedPayload).not.toContain('ignored');
    expect(stoppedPayload.match(/"finish_reason":"stop"/g)).toHaveLength(1);
    expect(stoppedPayload).toContain('"completion_tokens":3');
    expect(stoppedPayload).toContain('"total_tokens":7');

    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 2,
        cacheHitTokens: 0,
        model: 'hy3',
        totalTokens: 12,
      },
    ]);
  });

  it('records Responses usage when a Chat stream is cancelled', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-cancel-usage-token',
        upstream_protocol: 'responses',
        user_id: 'responses-cancel-usage@example.com',
      },
      filePath: '/tmp/responses-cancel-usage.json',
      filename: 'responses-cancel-usage.json',
    });
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: {
          'Content-Type': 'text/event-stream',
          'x-codebuddy-usage': JSON.stringify({
            input_tokens: 6,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 2,
            total_tokens: 8,
          }),
        },
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Cancel this stream', role: 'user' }],
        model: 'hy3',
        stream: true,
      },
      context,
    );

    await response.body?.cancel('client disconnected');

    expect(cancel).toHaveBeenCalledWith('client disconnected');
    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 4,
        model: 'hy3',
        totalTokens: 8,
      },
    ]);
  });

  it('covers Responses Chat stream terminal variants', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-stream-terminal-token',
        upstream_protocol: 'responses',
        user_id: 'responses-stream-terminal@example.com',
      },
      filePath: '/tmp/responses-stream-terminal.json',
      filename: 'responses-stream-terminal.json',
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.reasoning_summary_text.delta"}\n\n' +
            'data: {"type":"response.reasoning_text.delta","delta":"reason"}\n\n' +
            'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n' +
            'data: {"type":"response.function_call_arguments.delta","output_index":0}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"tailZ"}\n\n' +
            'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"partialQ"}\n\n' +
            'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.error","response":{"error":"response error"}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response('data: {"type":"error","error":{}}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('data: {"type":"response.failed"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":3,"input_tokens_details":{"cached_tokens":1,"cache_creation_tokens":2},"output_tokens_details":{"reasoning_tokens":2}}}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.completed","response":{"usage":"invalid"}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    const stream = async (
      options: Partial<Parameters<typeof proxyChatCompletions>[1]> = {},
    ): Promise<string> => {
      const response = await proxyChatCompletions(
        makeNextRequest('http://localhost/v1/chat/completions', {
          method: 'POST',
        }),
        {
          messages: [{ content: 'Stream terminal', role: 'user' }],
          model: 'hy3',
          stream: true,
          ...options,
        },
        context,
      );
      return response.text();
    };

    const toolPayload = await stream();
    expect(toolPayload).toContain('"reasoning_content":""');
    expect(toolPayload).toContain('"reasoning_content":"reason"');
    expect(toolPayload).toContain('"name":"function"');
    expect(toolPayload).toContain('"finish_reason":"tool_calls"');

    const completedPayload = await stream({
      stop: 'ZZ',
      stream_options: { include_usage: true },
    });
    expect(completedPayload).toContain('"content":"tail"');
    expect(completedPayload).toContain('"content":"Z"');
    expect(completedPayload).toContain('"total_tokens":0');

    const incompletePayload = await stream({ stop: 'QQ' });
    expect(incompletePayload).toContain('"content":"partial"');
    expect(incompletePayload).toContain('"content":"Q"');
    expect(incompletePayload).toContain('"finish_reason":"content_filter"');

    expect(await stream()).toContain('response error');
    expect(await stream()).toContain('[object Object]');
    expect(await stream()).toContain('Upstream Responses stream failed');

    const detailedUsagePayload = await stream({
      stream_options: { include_usage: true },
    });
    expect(detailedUsagePayload).toContain('"cached_tokens":1');
    expect(detailedUsagePayload).toContain('"cache_creation_tokens":2');
    expect(detailedUsagePayload).toContain('"reasoning_tokens":2');

    const invalidUsagePayload = await stream({
      stream_options: { include_usage: true },
    });
    expect(invalidUsagePayload).not.toContain('"usage":');
    expect(invalidUsagePayload).toContain('data: [DONE]');
  });

  it('maps Responses function call events back to Chat Completions SSE', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-stream-token',
        upstream_protocol: 'responses',
        user_id: 'responses-stream@example.com',
      },
      filePath: '/tmp/responses-stream.json',
      filename: 'responses-stream.json',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'event: response.output_item.added\n' +
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":""}}\n\n' +
          'event: response.function_call_arguments.delta\n' +
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":\\"Shanghai\\"}"}\n\n' +
          'event: response.incomplete\n' +
          'data: {"type":"response.incomplete"}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Use the weather tool', role: 'user' }],
        model: 'hy3',
        stream: true,
      },
      context,
    );
    const payload = await response.text();

    expect(payload).toContain('"name":"lookup_weather"');
    expect(payload).toContain('"arguments":"{\\"city\\":\\"Shanghai\\"}"');
    expect(payload.match(/"id":"call_1"/g)).toHaveLength(2);
    expect(payload).toContain('"finish_reason":"length"');
    expect(payload).toContain('data: [DONE]');
  });

  it('surfaces Responses stream failures as Chat Completions errors', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-error-token',
        upstream_protocol: 'responses',
        user_id: 'responses-error@example.com',
      },
      filePath: '/tmp/responses-error.json',
      filename: 'responses-error.json',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'event: response.failed\n' +
          'data: {"type":"response.failed","response":{"error":{"message":"upstream failed"}}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Fail upstream', role: 'user' }],
        model: 'hy3',
        stream: true,
      },
      context,
    );
    const payload = await response.text();

    expect(payload).toContain('"message":"upstream failed"');
    expect(payload).not.toContain('"finish_reason":"stop"');
    expect(payload).toContain('data: [DONE]');
  });

  it('records Responses usage when a Chat stream reader fails', async () => {
    const context = createProxyContextFromCredential({
      data: {
        bearer_token: 'responses-reader-failure-token',
        upstream_protocol: 'responses',
        user_id: 'responses-reader-failure@example.com',
      },
      filePath: '/tmp/responses-reader-failure.json',
      filename: 'responses-reader-failure.json',
    });
    const encoder = new TextEncoder();
    let pullCount = 0;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pullCount === 0) {
              pullCount += 1;
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.output_text.delta","delta":"partial","response":{"usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7}}}\n\n',
                ),
              );
              return;
            }

            controller.error(new Error('Responses reader failed'));
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'Fail after usage', role: 'user' }],
        model: 'hy3',
        stream: true,
      },
      context,
    );

    await expect(response.text()).rejects.toThrow('Responses reader failed');
    expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'hy3',
        totalTokens: 7,
      },
    ]);
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

  it('records CodeBuddy prompt cache hits from streamed usage', async () => {
    const credential = (await listCredentials()).credentials[0];
    expect(credential).toBeDefined();

    const context = await resolveProxyContextByCredentialFilename(
      String(credential?.filename),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"content":"cached"}}]}\n\n' +
          'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":125823,"completion_tokens":56,"total_tokens":125879,"prompt_tokens_details":{"cached_tokens":125376},"prompt_cache_hit_tokens":125376,"cache_read_input_tokens":0}}\n\n' +
          'data: [DONE]\n\n',
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'cached request', role: 'user' }],
        stream: true,
      },
      context,
    );
    await response.text();

    await waitForAsync(async () => {
      expect(
        (await getUsageAnalytics({ range: 'today' })).rangeSummary,
      ).toEqual({
        cacheHitTokens: 125376,
        callCount: 1,
        totalTokens: 125879,
      });
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

  it('normalizes developer messages as user messages for chat upstream', async () => {
    await addCredential({
      bearer_token: 'token-dev-role',
      created_at: Math.floor(Date.now() / 1000),
      first_message_role_to_system: true,
      first_system_message_role_to_user: true,
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
      { role: 'user', content: 'first developer' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'later developer' },
      { role: 'user', content: 'existing system' },
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
    expect(thirdBody.messages[0]?.role).toBe('user');
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

  it('cancels the upstream Chat stream when a Responses client disconnects', async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel,
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'cancel me', model: 'gpt-5.5', stream: true },
    );

    await response.body?.cancel('client disconnected');

    expect(cancel).toHaveBeenCalledWith('client disconnected');
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
      )
      .mockResolvedValueOnce(makeJsonResponse({ output_text: 'normalized' }));

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
              input_tokens_details: {
                cached_tokens: 1,
                cache_creation_tokens: 1,
              },
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
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":2,"cache_creation_tokens":1},"output_tokens":3,"total_tokens":8}}}',
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

    const normalizedResponse = await proxyResponsesUpstream(request, {
      messages: [
        { content: 'System compatibility instruction', role: 'system' },
        { content: 'messages compatibility input', role: 'user' },
      ],
      model: 'gpt-5.5',
    });
    await normalizedResponse.text();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)),
    ).toMatchObject({
      input: [
        {
          content: [
            { text: 'messages compatibility input', type: 'input_text' },
          ],
          role: 'user',
        },
      ],
      instructions: 'System compatibility instruction',
      model: 'gpt-5.5',
    });
    await waitForAsync(async () => {
      expect((await getUsageAnalytics({ range: 'today' })).tableRows).toEqual([
        {
          callCount: 3,
          cacheHitTokens: 3,
          model: 'gpt-5.5',
          totalTokens: 14,
        },
      ]);
    });
  });

  it('waits for streamed response bindings before forwarding response ids', async () => {
    let resolveBinding: (() => void) | undefined;
    const binding = new Promise<void>((resolve) => {
      resolveBinding = resolve;
    });
    const onResponseId = vi.fn(async () => binding);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'data: {"type":"response.created","response":{"id":"resp_delayed_binding"}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyResponsesUpstream(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'bind before forwarding', model: 'gpt-5.5', stream: true },
      undefined,
      undefined,
      onResponseId,
    );
    const reader = response.body!.getReader();
    let readSettled = false;
    const readPromise = reader.read().then((result) => {
      readSettled = true;
      return result;
    });

    await waitForAsync(async () => {
      expect(onResponseId).toHaveBeenCalledWith('resp_delayed_binding');
    });
    expect(readSettled).toBe(false);

    resolveBinding?.();
    const firstChunk = await readPromise;
    expect(new TextDecoder().decode(firstChunk.value)).toContain(
      'resp_delayed_binding',
    );
    expect((await reader.read()).done).toBe(true);
  });

  it('cancels the upstream Responses stream when the client disconnects', async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel,
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const response = await proxyResponsesUpstream(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'cancel me', model: 'gpt-5.5', stream: true },
    );

    await response.body?.cancel('client disconnected');

    expect(cancel).toHaveBeenCalledWith('client disconnected');
  });

  it('errors the downstream Responses stream when the upstream reader fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('upstream connection reset'));
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
          },
        },
      ),
    );

    const response = await proxyResponsesUpstream(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'fail while streaming', model: 'gpt-5.5', stream: true },
    );

    await expect(response.text()).rejects.toThrow('upstream connection reset');
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

  it('uses the selected credential model for Responses requests without a model', async () => {
    const credential = await addCredential({
      bearer_token: 'credential-scoped-model-token',
      responses_passthrough: true,
      supported_models: 'glm-credential-scoped',
      user_id: 'credential-scoped-model@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Credential Scoped Responses Key',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeJsonResponse({ output_text: 'ok' }));

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', {
        headers: { authorization: `Bearer ${accessKey.secret}` },
        method: 'POST',
      }),
      { input: 'hello' },
    );

    expect(response.status).toBe(200);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({
      input: 'hello',
      model: 'glm-credential-scoped',
    });
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

  it('pins upstream Responses follow-ups to the original credential', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-response-binding-a',
      upstream_protocol: 'responses',
      user_id: 'response-binding-a@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-response-binding-b',
      upstream_protocol: 'responses',
      user_id: 'response-binding-b@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: 'Responses Binding Key',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'resp_bound_upstream',
          object: 'response',
          output_text: 'first',
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 'resp_bound_follow_up',
          object: 'response',
          output_text: 'second',
        }),
      );
    const request = makeNextRequest('http://localhost/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessKey.secret}` },
    });

    const firstResponse = await handleResponsesRequest(request, {
      input: 'first',
      model: 'hy3',
    });
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();

    await addCredential(
      { upstream_protocol: 'chat' },
      firstCredential.filename,
    );

    const followUpResponse = await handleResponsesRequest(request, {
      input: 'second',
      previous_response_id: 'resp_bound_upstream',
    });
    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();

    const firstAuthorization = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers,
    ).get('authorization');
    const secondAuthorization = new Headers(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).headers,
    ).get('authorization');
    expect(secondAuthorization).toBe(firstAuthorization);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://copilot.tencent.com/responses',
    );
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)),
    ).toMatchObject({ model: 'hy3' });
  });

  it('keeps Chat-backed Responses sessions on Chat after protocol changes', async () => {
    const credential = await addCredential({
      bearer_token: 'token-chat-session-binding',
      upstream_protocol: 'chat',
      user_id: 'chat-session-binding@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Chat Session Binding Key',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'first answer' } }],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'second answer' } }],
        }),
      );
    const request = makeNextRequest('http://localhost/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessKey.secret}` },
    });

    const firstResponse = await handleResponsesRequest(request, {
      input: 'first question',
      model: 'hy3',
    });
    const firstPayload = (await firstResponse.json()) as { id: string };

    await addCredential(
      { upstream_protocol: 'responses' },
      credential.filename,
    );

    const followUpResponse = await handleResponsesRequest(request, {
      input: 'second question',
      previous_response_id: firstPayload.id,
    });
    expect(followUpResponse.status).toBe(200);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://copilot.tencent.com/v2/chat/completions',
    );
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)),
    ).toMatchObject({
      messages: [
        { content: 'first question', role: 'user' },
        { content: 'first answer', role: 'assistant' },
        { content: 'second question', role: 'user' },
      ],
      model: 'hy3',
    });
  });

  it('covers proxy context helpers for saved credentials', async () => {
    const createdCredential = await addCredential({
      bearer_token: 'token-from-bearer-token',
      first_message_role_to_system: true,
      first_system_message_role_to_user: true,
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
    expect(created.preferences.firstSystemMessageRoleToUser).toBe(true);
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

  it('keeps local response byte accounting valid across stale indexes and resets', async () => {
    const responseState = globalThis as typeof globalThis & {
      __codebuddy2apiResponseSessionBytes__?: Map<string, number>;
      __codebuddy2apiResponseSessionTotalBytes__?: number;
      __codebuddy2apiResponseSessions__?: Map<string, { createdAt: number }>;
    };
    delete responseState.__codebuddy2apiResponseSessionTotalBytes__;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'first local response' } }],
          model: 'gpt-5.5',
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'second local response' } }],
          model: 'gpt-5.5',
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: 'third local response' } }],
          model: 'gpt-5.5',
        }),
      );

    const first = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'first local response', model: 'gpt-5.5' },
    );
    const firstId = (await first.json()).id as string;
    const firstSession =
      responseState.__codebuddy2apiResponseSessions__!.get(firstId)!;
    firstSession.createdAt = Date.now() - 60 * 60 * 1000 - 1;
    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'prune indexed response', model: 'gpt-5.5' },
    );

    const second = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'second local response', model: 'gpt-5.5' },
    );
    const secondId = (await second.json()).id as string;
    const secondSession =
      responseState.__codebuddy2apiResponseSessions__!.get(secondId)!;
    secondSession.createdAt = Date.now() - 60 * 60 * 1000 - 1;
    responseState.__codebuddy2apiResponseSessionBytes__?.delete(secondId);
    await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      { input: 'prune stale index', model: 'gpt-5.5' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    resetResponseSessions();
    expect(responseState.__codebuddy2apiResponseSessionTotalBytes__).toBe(0);
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
    expect(resolved.preferences.upstreamProtocol).toBe('chat');
  });

  it('keeps legacy and current upstream protocol fields synchronized', async () => {
    const created = await addCredential({
      bearer_token: 'token-protocol-sync',
      upstream_protocol: 'responses',
      user_id: 'protocol-sync@example.com',
    });

    let record = (await readCredentialRecords()).find(
      (credential) => credential.filename === created.filename,
    );
    expect(record?.data).toMatchObject({
      responses_passthrough: true,
      upstream_protocol: 'responses',
    });

    await addCredential({ upstream_protocol: 'chat' }, created.filename);
    record = (await readCredentialRecords()).find(
      (credential) => credential.filename === created.filename,
    );
    expect(record?.data).toMatchObject({
      responses_passthrough: false,
      upstream_protocol: 'chat',
    });

    await addCredential({ responses_passthrough: true }, created.filename);
    record = (await readCredentialRecords()).find(
      (credential) => credential.filename === created.filename,
    );
    expect(record?.data).toMatchObject({
      responses_passthrough: true,
      upstream_protocol: 'responses',
    });
  });

  it('discovers models per credential without live upstream requests', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              agents: [{ models: ['glm-5.1', 'disabled', 42], name: 'cli' }],
              models: [
                { id: 'glm-5.1', name: 'GLM 5.1' },
                { disabled: true, id: 'disabled', name: 'Disabled' },
                { id: 'fallback-name', name: '   ' },
              ],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1 })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { models: [] } })),
      )
      .mockRejectedValue(new Error('Upstream unavailable'));

    await expect(
      getModelsForCredential({
        bearerToken: 'token-a',
        credentialData: {
          domain: 'example.com',
          enterprise_id: 'enterprise-a',
          tenant_id: 'tenant-a',
        },
      }),
    ).resolves.toEqual([{ displayName: 'GLM 5.1', id: 'glm-5.1' }]);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer token-a');
    expect(headers.get('x-domain')).toBe('example.com');
    expect(headers.get('x-enterprise-id')).toBe('enterprise-a');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');

    await expect(
      getModelsForCredential({ bearerToken: 'token-b', credentialData: {} }),
    ).rejects.toThrow('Model discovery failed with status 503');
    await expect(
      getModelsForCredential({ bearerToken: 'token-c', credentialData: {} }),
    ).rejects.toThrow('Model discovery returned an unsuccessful response');
    await expect(
      getModelsForCredential({ bearerToken: 'token-d', credentialData: {} }),
    ).resolves.toEqual([]);

    const records = [
      {
        data: { supported_models: 'glm-saved,glm-other' },
        filePath: '',
        filename: 'saved.json',
      },
      {
        data: { bearer_token: 'token-failing' },
        filePath: '',
        filename: 'failing.json',
      },
      { data: {}, filePath: '', filename: 'empty.json' },
    ];
    await expect(getModelsForCredentials(records)).resolves.toEqual([
      { displayName: 'glm-other', id: 'glm-other' },
      { displayName: 'glm-saved', id: 'glm-saved' },
    ]);
    await expect(getModelsByCredential(records)).resolves.toEqual({
      'empty.json': { error: null, models: [] },
      'failing.json': { error: 'Upstream unavailable', models: [] },
      'saved.json': { error: null, models: [] },
    });
  });

  it('returns models in both OpenAI-compatible and admin-friendly shapes', async () => {
    const secondCredential = await addCredential({
      bearer_token: 'second-model-token',
      user_id: 'second-model@example.com',
    });
    const credentials = await listCredentials();
    const accessKey = await createAccessKey({
      credentialFilenames: [
        credentials.credentials[0].filename as string,
        secondCredential.filename,
      ],
      name: 'Model Discovery Key',
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        const token = new Headers(init?.headers).get('authorization');
        const models =
          token === 'Bearer second-model-token'
            ? [
                { id: 'shared-model', name: 'Shared' },
                { id: 'second-model', name: 'Second' },
              ]
            : [
                { id: 'default-model', name: 'Default' },
                { disabled: true, id: 'disabled-model', name: 'Disabled' },
                { id: 'shared-model', name: 'Shared' },
              ];

        return makeJsonResponse({
          code: 0,
          data: {
            agents: [
              {
                models: models.map((model) => model.id),
                name: 'cli',
              },
            ],
            models,
          },
        });
      });
    const payload = (await (
      await getModelsResponse(
        makeNextRequest('http://localhost/v1/models', {
          headers: { authorization: `Bearer ${accessKey.secret}` },
        }),
      )
    ).json()) as {
      data: Array<Record<string, unknown>>;
      models: Array<Record<string, unknown>>;
    };

    expect(secondCredential.filename).toBeTruthy();
    expect(payload.models).toEqual(payload.data);
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'default-model' }),
        expect.objectContaining({ id: 'second-model' }),
        expect.objectContaining({ id: 'shared-model' }),
      ]),
    );
    expect(payload.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'disabled-model' }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      )
      // refreshCredentialModels after the credential is saved
      .mockResolvedValueOnce(
        makeJsonResponse({
          code: 0,
          data: {
            agents: [{ models: ['glm-5.1'], name: 'cli' }],
            models: [{ id: 'glm-5.1', name: 'GLM 5.1' }],
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
    expect(
      (await readCredentialRecords()).find(
        (credential) => credential.filename === savedCredential?.filename,
      )?.data.supported_models,
    ).toBe('glm-5.1');

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
