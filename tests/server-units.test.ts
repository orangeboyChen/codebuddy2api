import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  getAnthropicAuthErrorResponse,
  getAuthErrorResponse,
} from '@/lib/server/auth';
import {
  getAuthCallbackResponse,
  pollCodeBuddyAuth,
  startCodeBuddyAuth,
} from '@/lib/server/codebuddy-auth';
import { proxyChatCompletions } from '@/lib/server/codebuddy';
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
} from '@/lib/server/credentials';
import {
  handleResponsesRequest,
  resetResponseSessions,
} from '@/lib/server/responses';
import { updateSettings, getActiveConfig } from '@/lib/server/config';
import { getRequestHeaderMap } from '@/lib/server/http';
import {
  getUsageStats,
  recordCredentialUsage,
  recordModelUsage,
  resetUsageStats,
} from '@/lib/server/stats';

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

describe('server units', () => {
  beforeEach(() => {
    cleanupTempState();
    resetCredentialRuntimeState();
    resetResponseSessions();
    resetUsageStats();
    vi.restoreAllMocks();
    process.env.CODEBUDDY_CONFIG_PATH = '.tmp-test-config/config.json';
    process.env.CODEBUDDY_CREDS_DIR = '.tmp-test-creds';
    process.env.CODEBUDDY_PASSWORD = '';
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_API_KEY = '';
    process.env.CODEBUDDY_ROTATION_COUNT = '1';
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('covers auth guard branches', () => {
    expect(
      getAuthErrorResponse(makeNextRequest('http://localhost/test')),
    ).toBeNull();

    process.env.CODEBUDDY_PASSWORD = 'secret';

    expect(
      getAuthErrorResponse(makeNextRequest('http://localhost/test'))?.status,
    ).toBe(401);
    expect(
      getAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: 'Bearer nope' },
        }),
      )?.status,
    ).toBe(403);
    expect(
      getAuthErrorResponse(
        makeNextRequest('http://localhost/test', {
          headers: { authorization: 'Bearer secret' },
        }),
      ),
    ).toBeNull();
  });

  it('covers anthropic auth with x-api-key and bearer', async () => {
    // No password configured — both pass.
    expect(
      getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages'),
      ),
    ).toBeNull();

    process.env.CODEBUDDY_PASSWORD = 'anthropic-secret';

    // Missing key entirely.
    const noKey = getAnthropicAuthErrorResponse(
      makeNextRequest('http://localhost/v1/messages'),
    );
    expect(noKey?.status).toBe(401);
    expect((await noKey!.json()).type).toBe('error');

    // Wrong key via x-api-key.
    expect(
      getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages', {
          headers: { 'x-api-key': 'wrong' },
        }),
      )?.status,
    ).toBe(403);

    // Correct key via x-api-key.
    expect(
      getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages', {
          headers: { 'x-api-key': 'anthropic-secret' },
        }),
      ),
    ).toBeNull();

    // Correct key via Authorization: Bearer.
    expect(
      getAnthropicAuthErrorResponse(
        makeNextRequest('http://localhost/v1/messages', {
          headers: { authorization: 'Bearer anthropic-secret' },
        }),
      ),
    ).toBeNull();
  });

  it('covers credential rotation, invalid operations, and usage stats', () => {
    expect(getCurrentCredentialInfo().status).toBe('no_credentials');
    expect(selectCredential(0).success).toBe(false);
    expect(deleteCredentialByIndex(0).success).toBe(false);

    addCredential({
      bearer_token: 'expired',
      created_at: 1,
      expires_in: 1,
      user_id: 'expired@example.com',
    });
    addCredential({
      bearer_token: 'token-1',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      enterpriseId: 'tenant-a',
      user_id: 'one@example.com',
    });
    addCredential({
      bearer_token: 'token-2',
      created_at: Math.floor(Date.now() / 1000),
      expires_in: 3600,
      tenant_id: 'tenant-b',
      user_id: 'two@example.com',
    });

    const listed = listCredentials();
    expect(listed.credentials[0].is_expired).toBe(true);
    expect(listed.credentials[1].tenant_id).toBe('tenant-a');

    const first = resolveCredentialForRequest();
    const second = resolveCredentialForRequest();
    expect(first?.data.user_id).toBe('one@example.com');
    expect(second?.data.user_id).toBe('two@example.com');

    expect(selectCredential(1).success).toBe(true);
    expect(resolveCredentialForRequest()?.data.user_id).toBe('one@example.com');

    const toggle = toggleAutoRotation();
    expect(toggle.auto_rotation_enabled).toBe(false);
    expect(resumeAutoRotation().success).toBe(true);

    recordModelUsage('glm-5.1');
    recordCredentialUsage('cred-a');
    expect(getUsageStats().model_usage['glm-5.1']).toBe(1);
    expect(getUsageStats().credential_usage['cred-a']).toBe(1);
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
    const missingApiKey = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'hello' }],
      },
    );
    expect(missingApiKey.status).toBe(500);

    addCredential({
      bearer_token: 'token-a',
      created_at: Math.floor(Date.now() / 1000),
      enterprise_id: 'tenant-a',
      user_id: 'token@example.com',
    });
    process.env.CODEBUDDY_AUTH_MODE = 'token';

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
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

    const upstreamFailure = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
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
          'X-Conversation-ID': 'conv-1',
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      ((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Headers).get(
        'X-Tenant-Id',
      ),
    ).toBe('tenant-a');
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
        .max_tokens,
    ).toBe(12);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
        .max_completion_tokens,
    ).toBe(12);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
        .response_format,
    ).toBeUndefined();
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
      messages: Array<{ role: string; content: string }>;
    };
    expect(followUpBody.messages.map((message) => message.content)).toContain(
      'lookup_weather({"city":"Shanghai"})',
    );
    expect(followUpBody.messages.map((message) => message.content)).toContain(
      '{"temperature":30}',
    );

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
    ).toBe(2);
    expect(
      streamIndexedToolCallText.match(/response\.output_item\.done/g)?.length,
    ).toBe(2);

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
    const credInfo = getCurrentCredentialInfo();
    expect(credInfo.status).toBe('auto_rotation');
    expect(credInfo.tenant_id).toBe('tenant-456');
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

  it('coerces nullable string settings to strings', () => {
    updateSettings({ CODEBUDDY_PASSWORD: 12345, CODEBUDDY_API_KEY: true });

    const config = getActiveConfig();

    expect(config.CODEBUDDY_PASSWORD).toBe('12345');
    expect(config.CODEBUDDY_API_KEY).toBe('true');
  });
});
