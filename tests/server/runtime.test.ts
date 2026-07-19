import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import * as AdminChatRoute from '@/app/admin-api/chat/completions/route';
import * as AdminAccessKeysByIdRoute from '@/app/admin-api/access-keys/[id]/route';
import * as AdminAccessKeySecretRoute from '@/app/admin-api/access-keys/[id]/secret/route';
import * as AdminAccessKeysRoute from '@/app/admin-api/access-keys/route';
import * as AdminCredentialsAutoRoute from '@/app/admin-api/credentials/auto/route';
import * as AdminCredentialsCurrentRoute from '@/app/admin-api/credentials/current/route';
import * as AdminCredentialsDeleteRoute from '@/app/admin-api/credentials/delete/route';
import * as AdminCredentialsRoute from '@/app/admin-api/credentials/route';
import * as AdminCredentialsSelectRoute from '@/app/admin-api/credentials/select/route';
import * as AdminCredentialsToggleRoute from '@/app/admin-api/credentials/toggle-rotation/route';
import * as AdminSettingsRoute from '@/app/admin-api/settings/route';
import * as AdminStatsRoute from '@/app/admin-api/stats/route';
import * as AdminUsageClearRoute from '@/app/admin-api/usage/clear/route';
import * as AdminUsageRoute from '@/app/admin-api/usage/route';
import * as CallbackRoute from '@/app/codebuddy/auth/callback/route';
import * as PollRoute from '@/app/codebuddy/auth/poll/route';
import * as StartRoute from '@/app/codebuddy/auth/start/route';
import * as HealthRoute from '@/app/health/route';
import * as V1ChatRoute from '@/app/v1/chat/completions/route';
import * as V1ModelsRoute from '@/app/v1/models/route';
import * as V1ResponsesRoute from '@/app/v1/responses/route';
import { resetCredentialRuntimeState } from '@/lib/server/domain/credentials';
import { listDebugLogs, updateDebugSettings } from '@/lib/server/domain/debug';
import { resetResponseSessions } from '@/lib/server/proxy/responses';
import { resetUsageStats } from '@/lib/server/domain/stats';
import { recordUsageEvent } from '@/lib/server/domain/usage';
import { resetStorageRuntime } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-runtime-root');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true });
};

const makeNextRequest = (
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
): NextRequest => {
  return new NextRequest(url, init);
};

const makeJsonRequest = (url: string, body: unknown): Request => {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
};

const makeUpstreamJsonResponse = (
  payload: Record<string, unknown>,
): Response => {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

const makeSseResponse = (frames: string[]): Response => {
  return new Response(frames.join(''), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

describe('server runtime', () => {
  beforeEach(async () => {
    cleanupTempState();
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PERSISTENCE;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.DATABASE_URL;
    resetStorageRuntime();
    resetCredentialRuntimeState();
    resetResponseSessions();
    await resetUsageStats();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_API_KEY = '';
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('serves health and model metadata', async () => {
    const healthPayload = await (await HealthRoute.GET()).json();
    const modelsPayload = await (
      await V1ModelsRoute.GET(makeNextRequest('http://localhost/v1/models'))
    ).json();

    expect(healthPayload.status).toBe('healthy');
    expect(healthPayload.storage).toBe('file');
    expect(healthPayload.active_credential).toBeUndefined();
    expect(modelsPayload.object).toBe('list');
    expect(Array.isArray(modelsPayload.data)).toBe(true);
    expect(modelsPayload.data[0].id).toBeTruthy();
  });

  it('reports unhealthy when storage initialization fails', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
    process.env.CODEBUDDY_STORAGE_PG_URL = 'postgres://example.test/codebuddy';
    resetStorageRuntime();

    const response = await HealthRoute.GET();

    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe('unhealthy');
  });

  it('manages settings and credentials through admin routes', async () => {
    const settingsBefore = await (
      await AdminSettingsRoute.GET(
        new Request('http://localhost/admin-api/settings'),
      )
    ).json();
    expect(settingsBefore.settings.CODEBUDDY_AUTH_MODE).toBe('auto');
    expect(settingsBefore.settings.CODEBUDDY_ADMIN_PASSKEY_RP_ID).toBe('');
    expect(settingsBefore.labels.CODEBUDDY_ADMIN_PASSKEY_RP_ID).toContain(
      'Passkey RP ID',
    );

    const saveResponse = await AdminSettingsRoute.POST(
      makeJsonRequest('http://localhost/admin-api/settings', {
        settings: {
          CODEBUDDY_ADMIN_PASSKEY_RP_ID: 'example.com',
          CODEBUDDY_AUTH_MODE: 'token',
        },
      }),
    );
    const savedPayload = await saveResponse.json();
    expect(savedPayload.settings.CODEBUDDY_AUTH_MODE).toBe('token');
    expect(savedPayload.settings.CODEBUDDY_ADMIN_PASSKEY_RP_ID).toBe(
      'example.com',
    );
    expect(fs.existsSync(path.join(tempDataDir, 'runtime.json'))).toBe(true);

    const addResponse = await AdminCredentialsRoute.POST(
      makeJsonRequest('http://localhost/admin-api/credentials', {
        bearer_token: 'token-a',
        user_id: 'alice@example.com',
        domain: 'copilot.tencent.com',
        enterprise_id: 'ent-1',
      }),
    );
    const addPayload = await addResponse.json();
    expect(addPayload.success).toBe(true);

    const listPayload = await (
      await AdminCredentialsRoute.GET(
        new Request('http://localhost/admin-api/credentials'),
      )
    ).json();
    expect(listPayload.credentials).toHaveLength(1);
    expect(listPayload.credentials[0].tenant_id).toBe('ent-1');

    const currentPayload = await (
      await AdminCredentialsCurrentRoute.GET(
        new Request('http://localhost/admin-api/credentials/current'),
      )
    ).json();
    expect(currentPayload.filename).toContain('.json');

    const createdAccessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [listPayload.credentials[0].filename],
          name: 'Alice Key',
        }),
      )
    ).json();
    expect(createdAccessKeyPayload.secret.startsWith('cb2_')).toBe(true);
    expect(createdAccessKeyPayload.access_key.name).toBe('Alice Key');

    const listedAccessKeys = await (
      await AdminAccessKeysRoute.GET(
        new Request('http://localhost/admin-api/access-keys'),
      )
    ).json();
    expect(listedAccessKeys.access_keys).toHaveLength(1);
    expect(listedAccessKeys.access_keys[0].maskedSecret).toContain('****');

    const revealedSecretPayload = await (
      await AdminAccessKeySecretRoute.GET(new Request('http://localhost'), {
        params: Promise.resolve({
          id: createdAccessKeyPayload.access_key.id,
        }),
      })
    ).json();
    expect(revealedSecretPayload.secret).toBe(createdAccessKeyPayload.secret);

    const updatedAccessKeyPayload = await (
      await AdminAccessKeysByIdRoute.PATCH(
        makeJsonRequest(
          `http://localhost/admin-api/access-keys/${createdAccessKeyPayload.access_key.id}`,
          {
            credential_filenames: [listPayload.credentials[0].filename],
            name: 'Alice Key Updated',
          },
        ),
        {
          params: Promise.resolve({
            id: createdAccessKeyPayload.access_key.id,
          }),
        },
      )
    ).json();
    expect(updatedAccessKeyPayload.access_key.name).toBe('Alice Key Updated');

    const accessKeyListBeforeDelete = await (
      await AdminAccessKeysRoute.GET(
        new Request('http://localhost/admin-api/access-keys'),
      )
    ).json();
    expect(
      accessKeyListBeforeDelete.access_keys[0].credentialFilenames,
    ).toEqual([listPayload.credentials[0].filename]);

    const invalidSelectResponse = await AdminCredentialsSelectRoute.POST(
      makeJsonRequest('http://localhost/admin-api/credentials/select', {
        index: null,
      }),
    );
    expect(invalidSelectResponse.status).toBe(400);

    const togglePayload = await (
      await AdminCredentialsToggleRoute.POST(
        new Request('http://localhost/admin-api/credentials/toggle-rotation', {
          method: 'POST',
        }),
      )
    ).json();
    expect(togglePayload.auto_rotation_enabled).toBe(true);

    const autoPayload = await (
      await AdminCredentialsAutoRoute.POST(
        new Request('http://localhost/admin-api/credentials/auto', {
          method: 'POST',
        }),
      )
    ).json();
    expect(autoPayload.success).toBe(true);

    const deletedAccessKeyPayload = await (
      await AdminAccessKeysByIdRoute.DELETE(new Request('http://localhost'), {
        params: Promise.resolve({
          id: createdAccessKeyPayload.access_key.id,
        }),
      })
    ).json();
    expect(deletedAccessKeyPayload.success).toBe(true);

    const deletePayload = await (
      await AdminCredentialsDeleteRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials/delete', {
          index: 0,
        }),
      )
    ).json();
    expect(deletePayload.success).toBe(true);

    const accessKeyListAfterDelete = await (
      await AdminAccessKeysRoute.GET(
        new Request('http://localhost/admin-api/access-keys'),
      )
    ).json();
    expect(accessKeyListAfterDelete.access_keys).toEqual([]);
  });

  it('enforces auth on protected v1 routes and mirrors successful actions', async () => {
    await AdminCredentialsRoute.POST(
      makeJsonRequest('http://localhost/admin-api/credentials', {
        bearer_token: 'token-b',
        user_id: 'bob@example.com',
      }),
    );

    const credentialList = await (
      await AdminCredentialsRoute.GET(
        new Request('http://localhost/admin-api/credentials'),
      )
    ).json();
    const createdAccessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [credentialList.credentials[0].filename],
          name: 'Protected Key',
        }),
      )
    ).json();
    const unauthorizedModels = await V1ModelsRoute.GET(
      makeNextRequest('http://localhost/v1/models'),
    );
    expect(unauthorizedModels.status).toBe(401);

    const authHeaders = {
      authorization: `Bearer ${createdAccessKeyPayload.secret}`,
    };

    const authorizedModels = await (
      await V1ModelsRoute.GET(
        makeNextRequest('http://localhost/v1/models', {
          headers: authHeaders,
        }),
      )
    ).json();
    expect(authorizedModels.object).toBe('list');
  });

  it('proxies chat completions for admin and v1 endpoints', async () => {
    const adminCredentialPayload = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'chat-token',
          user_id: 'chat@example.com',
        }),
      )
    ).json();
    const accessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [adminCredentialPayload.filename],
          name: 'Chat Proxy Key',
        }),
      )
    ).json();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        makeSseResponse([
          'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","model":"glm-5.1","choices":[{"delta":{"content":"hello "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"from upstream"},"finish_reason":"stop"}],"usage":{"completion_tokens":2,"prompt_tokens":3,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const adminResponse = await AdminChatRoute.POST(
      makeNextRequest('http://localhost/admin-api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': 'trace-1',
        },
        body: JSON.stringify({
          model: 'glm-5.1',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
        }),
      }),
    );
    const adminPayload = await adminResponse.json();
    expect(adminPayload.choices[0].message.content).toBe('hello from upstream');

    const v1Response = await V1ChatRoute.POST(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'glm-5.1',
          messages: [{ role: 'user', content: 'hello again' }],
          stream: false,
        }),
      }),
    );
    expect(v1Response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get(
        'authorization',
      ),
    ).toBe('Bearer chat-token');
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
        .stream,
    ).toBe(true);
  });

  it('does not persist rejected client requests in debug logs', async () => {
    const credentialPayload = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'debug-token',
          user_id: 'debug@example.com',
        }),
      )
    ).json();
    await AdminAccessKeysRoute.POST(
      makeJsonRequest('http://localhost/admin-api/access-keys', {
        credential_filenames: [credentialPayload.filename],
        name: 'Debug Key',
      }),
    );
    await updateDebugSettings({ enabled: true });

    const response = await V1ChatRoute.POST(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ content: 'untrusted request', role: 'user' }],
        }),
      }),
    );

    expect(response.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await listDebugLogs()).toEqual([]);
  });

  it('falls back to the default model when clients send a blank model', async () => {
    const credentialPayload = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'blank-model-token',
          user_id: 'blank-model@example.com',
        }),
      )
    ).json();
    const accessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [credentialPayload.filename],
          name: 'Blank Model Key',
        }),
      )
    ).json();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        makeSseResponse([
          'data: {"id":"chatcmpl_blank","object":"chat.completion.chunk","model":"glm-5.1","choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}],"usage":{"completion_tokens":1,"prompt_tokens":1,"total_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const response = await V1ChatRoute.POST(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: '',
          messages: [{ role: 'user', content: 'hello' }],
          stream: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
        .model,
    ).toBe('glm-5.1');
  });

  it('supports responses api for non-stream, stream, tool flattening, and previous response state', async () => {
    const responsesCredentialPayload = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'responses-token',
          user_id: 'responses@example.com',
        }),
      )
    ).json();
    const accessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [responsesCredentialPayload.filename],
          name: 'Responses Proxy Key',
        }),
      )
    ).json();

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"chatcmpl_resp_1","object":"chat.completion.chunk","model":"gpt-5.5","choices":[{"delta":{"content":"first "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"completion_tokens":2,"prompt_tokens":2,"total_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"chatcmpl_resp_2","object":"chat.completion.chunk","model":"gpt-5.5","choices":[{"delta":{"content":"second "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"completion_tokens":1,"prompt_tokens":3,"total_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"chatcmpl_resp_3","object":"chat.completion.chunk","model":"gpt-5.5","choices":[{"delta":{"content":"third "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"completion_tokens":1,"prompt_tokens":4,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"stream "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"chatcmpl_resp_bad_tool","object":"chat.completion.chunk","model":"gpt-5.5","choices":[{"delta":{"content":"filtered "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"completion_tokens":1,"prompt_tokens":2,"total_tokens":3}}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const firstResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hello',
          instructions: 'Keep replies brief',
          tool_choice: { type: 'function', name: 'lookup_weather' },
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              description: 'Look up weather for a city',
              parameters: {
                type: 'object',
                properties: {},
              },
            },
          ],
          stream: false,
        }),
      }),
    );
    const firstPayload = await firstResponse.json();
    expect(firstPayload.output_text).toBe('first answer');

    const secondResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          previous_response_id: firstPayload.id,
          input: 'continue',
          stream: false,
        }),
      }),
    );
    const secondPayload = await secondResponse.json();
    expect(secondPayload.output_text).toBe('second answer');

    const thirdResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          previous_response_id: secondPayload.id,
          input: 'continue again',
          stream: false,
        }),
      }),
    );
    const thirdPayload = await thirdResponse.json();
    expect(thirdPayload.output_text).toBe('third answer');

    const streamResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'stream please',
          stream: true,
        }),
      }),
    );
    const streamText = await streamResponse.text();
    expect(streamText).toContain('response.output_text.delta');
    expect(streamText).toContain('stream answer');
    const firstUpstream = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(firstUpstream.tools).toHaveLength(1);
    expect(firstUpstream.tools[0].function.name).toBe('lookup_weather');
    expect(firstUpstream.tools[0].function.description).toBe(
      'Look up weather for a city',
    );
    expect(firstUpstream.tool_choice).toEqual({
      type: 'function',
      function: { name: 'lookup_weather' },
    });
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
        .messages[0].content,
    ).toBe('Keep replies brief');
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
        .messages[1].tool_calls,
    ).toBeUndefined();
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))
        .messages[0].content,
    ).toBe('Keep replies brief');
    expect(
      JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))
        .messages[1].tool_calls,
    ).toBeUndefined();

    // Built-in tool types are flattened into chat-completions function tools
    // when they carry callable function metadata. Pure placeholders without
    // callable metadata are still dropped.
    const badToolResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'hello',
          tools: [
            { type: 'file_search' },
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
              type: 'function',
              name: 'lookup_weather',
              description: 'Look up weather for a city',
              parameters: { type: 'object', properties: {} },
            },
            {
              type: 'mcp',
              server_label: 'svc',
              name: 'lookup_docs',
              description: 'Look up docs through MCP',
              parameters: { type: 'object', properties: {} },
            },
          ],
          stream: false,
        }),
      }),
    );
    expect(badToolResponse.status).toBe(200);
    const upstreamBadTool = JSON.parse(
      String(
        (
          fetchMock.mock.calls[
            fetchMock.mock.calls.length - 1
          ]?.[1] as RequestInit
        ).body,
      ),
    );
    expect(upstreamBadTool.tools).toHaveLength(3);
    expect(upstreamBadTool.tools[0].function.name).toBe('search_files');
    expect(upstreamBadTool.tools[1].function.name).toBe('lookup_weather');
    expect(upstreamBadTool.tools[2].function.name).toBe('svc__lookup_docs');

    const missingStateResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          previous_response_id: 'resp_missing',
          input: 'hello',
        }),
      }),
    );
    expect(missingStateResponse.status).toBe(400);
  });

  it("does not allow one access key to resume another key's response", async () => {
    const firstCredential = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'responses-owner-token',
          user_id: 'responses-owner@example.com',
        }),
      )
    ).json();
    const secondCredential = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'responses-other-token',
          user_id: 'responses-other@example.com',
        }),
      )
    ).json();
    const firstKey = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [firstCredential.filename],
          name: 'Response Owner Key',
        }),
      )
    ).json();
    const secondKey = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [secondCredential.filename],
          name: 'Response Other Key',
        }),
      )
    ).json();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"private"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" response"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const firstResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${firstKey.secret}` },
        body: JSON.stringify({ input: 'private prompt', model: 'glm-5.1' }),
      }),
    );
    const firstPayload = await firstResponse.json();
    const secondResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${secondKey.secret}` },
        body: JSON.stringify({
          input: 'attempt to continue',
          previous_response_id: firstPayload.id,
        }),
      }),
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps one responses session on the original credential within a pooled access key', async () => {
    const firstCredential = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'responses-affinity-first-token',
          user_id: 'responses-affinity-first@example.com',
        }),
      )
    ).json();
    const secondCredential = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'responses-affinity-second-token',
          user_id: 'responses-affinity-second@example.com',
        }),
      )
    ).json();
    const accessKey = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [
            firstCredential.filename,
            secondCredential.filename,
          ],
          name: 'Responses Affinity Key',
        }),
      )
    ).json();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" answer"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" answer"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      )
      .mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"third"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" answer"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

    const firstResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessKey.secret}` },
        body: JSON.stringify({ input: 'hello', model: 'glm-5.1' }),
      }),
    );
    const firstPayload = await firstResponse.json();
    const secondResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessKey.secret}` },
        body: JSON.stringify({
          input: 'continue',
          previous_response_id: firstPayload.id,
        }),
      }),
    );
    const thirdResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessKey.secret}` },
        body: JSON.stringify({ input: 'new thread', model: 'glm-5.1' }),
      }),
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(thirdResponse.status).toBe(200);

    const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Headers;
    const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit)
      .headers as Headers;
    const thirdHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit)
      .headers as Headers;

    expect(firstHeaders.get('Authorization')).toBe(
      'Bearer responses-affinity-first-token',
    );
    expect(secondHeaders.get('Authorization')).toBe(
      'Bearer responses-affinity-first-token',
    );
    expect(thirdHeaders.get('Authorization')).toBe(
      'Bearer responses-affinity-second-token',
    );
  });

  it('supports codebuddy auth start, poll, callback, and protected api settings', async () => {
    const jwtPayload = Buffer.from(
      JSON.stringify({
        email: 'coder@example.com',
        name: 'Coder',
        sub: 'sub-1',
      }),
    )
      .toString('base64url')
      .replaceAll('=', '');
    const accessToken = `header.${jwtPayload}.sig`;

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        makeUpstreamJsonResponse({
          code: 0,
          data: {
            state: 'auth-state-1',
            authUrl: 'https://copilot.tencent.com/login',
          },
        }),
      )
      .mockResolvedValueOnce(
        makeUpstreamJsonResponse({
          code: 11217,
          msg: 'login ing...',
        }),
      )
      .mockResolvedValueOnce(
        makeUpstreamJsonResponse({
          code: 0,
          data: {
            accessToken,
            domain: 'copilot.tencent.com',
            enterpriseId: 'enterprise-1',
            expiresIn: 3600,
            refreshToken: 'refresh-1',
            sessionState: 'session-1',
            tenantId: 'tenant-1',
            tokenType: 'Bearer',
          },
        }),
      );

    const startPayload = await (
      await StartRoute.GET(new Request('http://localhost/codebuddy/auth/start'))
    ).json();
    expect(startPayload.auth_state).toBe('auth-state-1');

    const pendingPoll = await (
      await PollRoute.POST(
        makeJsonRequest('http://localhost/codebuddy/auth/poll', {
          auth_state: 'auth-state-1',
        }),
      )
    ).json();
    expect(pendingPoll.error).toBe('authorization_pending');

    const successPoll = await (
      await PollRoute.POST(
        makeJsonRequest('http://localhost/codebuddy/auth/poll', {
          auth_state: 'auth-state-1',
        }),
      )
    ).json();
    expect(successPoll.saved).toBe(true);
    expect(successPoll.user_info.email).toBe('coder@example.com');

    const credentialListPayload = await (
      await AdminCredentialsRoute.GET(
        new Request('http://localhost/admin-api/credentials'),
      )
    ).json();
    expect(credentialListPayload.credentials[0].tenant_id).toBe('tenant-1');

    const callbackPayload = await (
      await CallbackRoute.GET(
        makeNextRequest(
          'http://localhost/codebuddy/auth/callback?code=ok&state=state-1',
        ),
      )
    ).json();
    expect(callbackPayload.code).toBe('ok');

    const statsPayload = await (
      await AdminStatsRoute.GET(new Request('http://localhost/admin-api/stats'))
    ).json();
    expect(statsPayload.credential_usage).toBeTruthy();
  });

  it('accepts x-api-key headers on protected inference and admin credential routes', async () => {
    const credentialPayload = await (
      await AdminCredentialsRoute.POST(
        makeJsonRequest('http://localhost/admin-api/credentials', {
          bearer_token: 'header-token',
          user_id: 'header@example.com',
        }),
      )
    ).json();
    const accessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [credentialPayload.filename],
          name: 'Header Key',
        }),
      )
    ).json();

    const modelsResponse = await V1ModelsRoute.GET(
      makeNextRequest('http://localhost/v1/models', {
        headers: {
          'x-api-key': accessKeyPayload.secret,
        },
      }),
    );
    expect(modelsResponse.status).toBe(200);

    const adminCredentialsResponse = await AdminCredentialsCurrentRoute.GET(
      makeNextRequest('http://localhost/admin-api/credentials/current', {
        headers: {
          'x-api-key': accessKeyPayload.secret,
        },
      }),
    );
    expect(adminCredentialsResponse.status).toBe(200);
  });

  it('serves persisted usage analytics and clears history through admin routes', async () => {
    const currentTimestamp = new Date();
    currentTimestamp.setMinutes(Math.max(0, currentTimestamp.getMinutes() - 1));

    await recordUsageEvent({
      accessKeyId: 'key-1',
      accessKeyName: 'Runtime Key',
      credentialFilename: 'runtime-credential.json',
      model: 'glm-5.1',
      route: '/v1/chat/completions',
      timestamp: currentTimestamp.toISOString(),
      usage: {
        input_tokens: 6,
        output_tokens: 4,
      },
    });

    const filteredUsageResponse = await AdminUsageRoute.PATCH(
      new Request('http://localhost/admin-api/usage', {
        body: JSON.stringify({
          accessKey: ['key-1'],
          autoRefreshSeconds: 30,
          credential: ['runtime-credential.json'],
          range: 'today',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      }),
    );
    expect(filteredUsageResponse.status).toBe(200);
    expect((await filteredUsageResponse.json()).range).toBe('today');

    const usageResponse = await AdminUsageRoute.GET(
      makeNextRequest('http://localhost/admin-api/usage'),
    );
    expect(usageResponse.status).toBe(200);
    const usagePayload = await usageResponse.json();
    expect(usagePayload.range).toBe('24h');
    expect(usagePayload.tableRows).toEqual([
      {
        callCount: 1,
        cacheHitTokens: 0,
        model: 'glm-5.1',
        totalTokens: 10,
      },
    ]);
    expect(usagePayload.filters.accessKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Runtime Key',
          value: 'key-1',
        }),
      ]),
    );
    expect(usagePayload.filters.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'runtime-credential.json',
          value: 'runtime-credential.json',
        }),
      ]),
    );

    const clearResponse = await AdminUsageClearRoute.POST(
      new Request('http://localhost/admin-api/usage/clear', {
        method: 'POST',
      }),
    );
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toEqual({
      success: true,
    });

    const clearedPayload = await (
      await AdminUsageRoute.GET(
        makeNextRequest('http://localhost/admin-api/usage'),
      )
    ).json();
    expect(clearedPayload.tableRows).toEqual([]);
    expect(clearedPayload.rangeSummary).toEqual({
      callCount: 0,
      cacheHitTokens: 0,
      totalTokens: 0,
    });
  });
});
