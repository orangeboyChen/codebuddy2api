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
import * as ApiSettingsRoute from '@/app/api/settings/route';
import * as CallbackRoute from '@/app/codebuddy/auth/callback/route';
import * as PollRoute from '@/app/codebuddy/auth/poll/route';
import * as StartRoute from '@/app/codebuddy/auth/start/route';
import * as HealthRoute from '@/app/health/route';
import * as V1ChatRoute from '@/app/v1/chat/completions/route';
import * as V1CredentialsAutoRoute from '@/app/v1/credentials/auto/route';
import * as V1CredentialsCurrentRoute from '@/app/v1/credentials/current/route';
import * as V1CredentialsDeleteRoute from '@/app/v1/credentials/delete/route';
import * as V1CredentialsRoute from '@/app/v1/credentials/route';
import * as V1CredentialsSelectRoute from '@/app/v1/credentials/select/route';
import * as V1CredentialsToggleRoute from '@/app/v1/credentials/toggle-rotation/route';
import * as V1ModelsRoute from '@/app/v1/models/route';
import * as V1ResponsesRoute from '@/app/v1/responses/route';
import { resetCredentialRuntimeState } from '@/lib/server/credentials';
import { resetResponseSessions } from '@/lib/server/responses';
import { resetUsageStats } from '@/lib/server/stats';

const tempConfigDir = path.join(process.cwd(), '.tmp-test-config');
const tempCredsDir = path.join(process.cwd(), '.tmp-test-creds');

const cleanupTempState = (): void => {
  fs.rmSync(tempConfigDir, { force: true, recursive: true });
  fs.rmSync(tempCredsDir, { force: true, recursive: true });
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
  beforeEach(() => {
    cleanupTempState();
    resetCredentialRuntimeState();
    resetResponseSessions();
    resetUsageStats();
    vi.restoreAllMocks();
    process.env.CODEBUDDY_CONFIG_PATH = '.tmp-test-config/config.json';
    process.env.CODEBUDDY_CREDS_DIR = '.tmp-test-creds';
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
    expect(healthPayload.active_credential).toBeUndefined();
    expect(modelsPayload.object).toBe('list');
    expect(Array.isArray(modelsPayload.data)).toBe(true);
    expect(modelsPayload.data[0].id).toBeTruthy();
  });

  it('manages settings and credentials through admin routes', async () => {
    const settingsBefore = await (await AdminSettingsRoute.GET()).json();
    expect(settingsBefore.settings.CODEBUDDY_AUTH_MODE).toBe('auto');

    const saveResponse = await AdminSettingsRoute.POST(
      makeJsonRequest('http://localhost/admin-api/settings', {
        settings: {
          CODEBUDDY_AUTH_MODE: 'token',
        },
      }),
    );
    const savedPayload = await saveResponse.json();
    expect(savedPayload.settings.CODEBUDDY_AUTH_MODE).toBe('token');
    expect(fs.existsSync(path.join(tempConfigDir, 'config.json'))).toBe(true);

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

    const listPayload = await (await AdminCredentialsRoute.GET()).json();
    expect(listPayload.credentials).toHaveLength(1);
    expect(listPayload.credentials[0].tenant_id).toBe('ent-1');

    const currentPayload = await (
      await AdminCredentialsCurrentRoute.GET()
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

    const listedAccessKeys = await (await AdminAccessKeysRoute.GET()).json();
    expect(listedAccessKeys.access_keys).toHaveLength(1);
    expect(listedAccessKeys.access_keys[0].maskedSecret).toContain('...');

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

    const invalidSelectResponse = await AdminCredentialsSelectRoute.POST(
      makeJsonRequest('http://localhost/admin-api/credentials/select', {
        index: null,
      }),
    );
    expect(invalidSelectResponse.status).toBe(400);

    const togglePayload = await (
      await AdminCredentialsToggleRoute.POST()
    ).json();
    expect(togglePayload.auto_rotation_enabled).toBe(true);

    const autoPayload = await (await AdminCredentialsAutoRoute.POST()).json();
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
  });

  it('enforces auth on protected v1 routes and mirrors successful actions', async () => {
    await AdminCredentialsRoute.POST(
      makeJsonRequest('http://localhost/admin-api/credentials', {
        bearer_token: 'token-b',
        user_id: 'bob@example.com',
      }),
    );

    const credentialList = await (await AdminCredentialsRoute.GET()).json();
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

    const unauthorized = await V1CredentialsRoute.GET(
      makeNextRequest('http://localhost/v1/credentials'),
    );
    expect(unauthorized.status).toBe(401);

    const authHeaders = {
      authorization: `Bearer ${createdAccessKeyPayload.secret}`,
    };
    const listPayload = await (
      await V1CredentialsRoute.GET(
        makeNextRequest('http://localhost/v1/credentials', {
          headers: authHeaders,
        }),
      )
    ).json();
    expect(listPayload.credentials).toHaveLength(1);

    const authorizedModels = await (
      await V1ModelsRoute.GET(
        makeNextRequest('http://localhost/v1/models', {
          headers: authHeaders,
        }),
      )
    ).json();
    expect(authorizedModels.object).toBe('list');

    const currentPayload = await (
      await V1CredentialsCurrentRoute.GET(
        makeNextRequest('http://localhost/v1/credentials/current', {
          headers: authHeaders,
        }),
      )
    ).json();
    expect(currentPayload.status).toBe('access_keys_enabled');
    expect(currentPayload.available_credential_count).toBe(1);

    const selectPayload = await (
      await V1CredentialsSelectRoute.POST(
        makeNextRequest('http://localhost/v1/credentials/select', {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ index: 0 }),
        }),
      )
    ).json();
    expect(selectPayload.success).toBe(true);

    const invalidSelectResponse = await V1CredentialsSelectRoute.POST(
      makeNextRequest('http://localhost/v1/credentials/select', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ index: null }),
      }),
    );
    expect(invalidSelectResponse.status).toBe(400);

    const togglePayload = await (
      await V1CredentialsToggleRoute.POST(
        makeNextRequest('http://localhost/v1/credentials/toggle-rotation', {
          method: 'POST',
          headers: authHeaders,
        }),
      )
    ).json();
    expect(togglePayload.success).toBe(true);

    const autoPayload = await (
      await V1CredentialsAutoRoute.POST(
        makeNextRequest('http://localhost/v1/credentials/auto', {
          method: 'POST',
          headers: authHeaders,
        }),
      )
    ).json();
    expect(autoPayload.success).toBe(true);

    const invalidDeleteResponse = await V1CredentialsDeleteRoute.POST(
      makeNextRequest('http://localhost/v1/credentials/delete', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ index: null }),
      }),
    );
    expect(invalidDeleteResponse.status).toBe(400);

    const deletePayload = await (
      await V1CredentialsDeleteRoute.POST(
        makeNextRequest('http://localhost/v1/credentials/delete', {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ index: 0 }),
        }),
      )
    ).json();
    expect(deletePayload.success).toBe(true);
  });

  it('proxies chat completions for admin and v1 endpoints', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

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
          authorization: 'Bearer ignored-without-access-key',
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
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
        .stream,
    ).toBe(true);
  });

  it('supports responses api for non-stream, stream, tool flattening, and previous response state', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

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
          authorization: 'Bearer secret',
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
          authorization: 'Bearer secret',
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
          authorization: 'Bearer secret',
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
          authorization: 'Bearer secret',
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
          authorization: 'Bearer secret',
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
    expect(upstreamBadTool.tools[2].function.name).toBe('lookup_docs');

    const missingStateResponse = await V1ResponsesRoute.POST(
      makeNextRequest('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
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

    const startPayload = await (await StartRoute.GET()).json();
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
      await AdminCredentialsRoute.GET()
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

    const accessKeyPayload = await (
      await AdminAccessKeysRoute.POST(
        makeJsonRequest('http://localhost/admin-api/access-keys', {
          credential_filenames: [credentialListPayload.credentials[0].filename],
          name: 'Settings Key',
        }),
      )
    ).json();
    const forbiddenSettings = await ApiSettingsRoute.GET(
      makeNextRequest('http://localhost/api/settings'),
    );
    expect(forbiddenSettings.status).toBe(401);

    const protectedSettings = await ApiSettingsRoute.GET(
      makeNextRequest('http://localhost/api/settings', {
        headers: {
          authorization: `Bearer ${accessKeyPayload.secret}`,
        },
      }),
    );
    expect(protectedSettings.status).toBe(200);

    const statsPayload = await (await AdminStatsRoute.GET()).json();
    expect(statsPayload.credential_usage).toBeTruthy();
  });
});
