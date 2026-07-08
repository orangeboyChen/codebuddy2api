import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { getAuthErrorResponse } from '@/lib/server/auth';
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
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
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
        stream: true,
      },
    );
    expect(await streaming.text()).toContain('choices');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      ((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Headers).get(
        'X-Tenant-Id',
      ),
    ).toBe('tenant-a');
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

  it('covers responses message mapping and malformed sse handling', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    vi.spyOn(globalThis, 'fetch')
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
});
