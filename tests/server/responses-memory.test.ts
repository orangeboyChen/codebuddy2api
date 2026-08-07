import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

const { deletePgSession, pgSessions, readPgSession, writePgSession } =
  vi.hoisted(() => {
    const sessions = new Map<string, unknown>();

    return {
      deletePgSession: vi.fn(async (_namespace: string, key: string) => {
        sessions.delete(key);
      }),
      pgSessions: sessions,
      readPgSession: vi.fn(async (_namespace: string, key: string) => {
        return sessions.get(key) ?? null;
      }),
      writePgSession: vi.fn(
        async (_namespace: string, key: string, value: unknown) => {
          sessions.set(key, value);
        },
      ),
    };
  });

vi.mock('@/lib/server/storage', async (importOriginal) => {
  const storage = await importOriginal<typeof import('@/lib/server/storage')>();

  return {
    ...storage,
    deleteStorageJson: async (namespace: string, key: string) => {
      if (namespace === 'responses') {
        await deletePgSession(namespace, key);
        return;
      }

      await storage.deleteStorageJson(namespace, key);
    },
    getStorageBackendMeta: () => ({
      backend: 'pg' as const,
      encryptionEnabled: true,
      schema: 'codebuddy2api',
    }),
    listStorageJson: async <T>(namespace: string) => {
      if (namespace === 'responses') {
        return [...pgSessions.entries()].map(([key, value]) => ({
          key,
          value: value as T,
        }));
      }

      return storage.listStorageJson<T>(namespace);
    },
    readStorageJson: async <T>(namespace: string, key: string) => {
      if (namespace === 'responses') {
        return (await readPgSession(namespace, key)) as T | null;
      }

      return storage.readStorageJson<T>(namespace, key);
    },
    writeStorageJson: async <T>(namespace: string, key: string, value: T) => {
      if (namespace === 'responses') {
        await writePgSession(namespace, key, value);
        return;
      }

      await storage.writeStorageJson(namespace, key, value);
    },
  };
});

import {
  addCredential,
  listCredentials,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import {
  proxyChatCompletions,
  proxyResponsesUpstream,
  resolveProxyContextByCredentialFilename,
} from '@/lib/server/proxy/codebuddy';
import {
  handleResponsesRequest,
  resetResponseSessions,
} from '@/lib/server/proxy/responses';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-responses-memory');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, maxRetries: 5, recursive: true });
};

const makeRequest = (): NextRequest => {
  return new NextRequest('http://localhost/v1/responses', { method: 'POST' });
};

const makeChatResponse = (content: string): Response => {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], model: 'gpt-5.5' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};

const makeChunkedResponse = (body: string): Response => {
  return new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
};

describe('Responses memory bounds', () => {
  beforeEach(async () => {
    cleanupTempState();
    resetCredentialRuntimeState();
    resetResponseSessions();
    pgSessions.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    await addCredential({
      bearer_token: 'responses-memory-token',
      responses_passthrough: false,
      user_id: 'responses-memory@example.com',
    });
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('uses PostgreSQL session storage and removes expired sessions', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeChatResponse('first response'))
      .mockResolvedValueOnce(makeChatResponse('follow-up response'))
      .mockResolvedValueOnce(makeChatResponse('pruned response'));

    const firstResponse = await handleResponsesRequest(makeRequest(), {
      input: 'start',
      model: 'gpt-5.5',
    });
    const firstPayload = (await firstResponse.json()) as { id: string };

    expect(writePgSession).toHaveBeenCalledWith(
      'responses',
      firstPayload.id,
      expect.objectContaining({ id: firstPayload.id }),
    );

    const followUpResponse = await handleResponsesRequest(makeRequest(), {
      input: 'continue',
      model: 'gpt-5.5',
      previous_response_id: firstPayload.id,
    });
    expect((await followUpResponse.json()).output_text).toBe(
      'follow-up response',
    );
    expect(readPgSession).toHaveBeenCalledWith('responses', firstPayload.id);

    const directlyExpiredId = 'resp_directly_expired';
    pgSessions.set(directlyExpiredId, {
      accessKeyId: null,
      createdAt: Date.now() - 60 * 60 * 1000 - 1,
      defaults: { instructions: null, tools: [] },
      id: directlyExpiredId,
      model: 'gpt-5.5',
      transcript: [],
    });
    const directlyExpiredResponse = await handleResponsesRequest(
      makeRequest(),
      {
        input: 'expired directly',
        model: 'gpt-5.5',
        previous_response_id: directlyExpiredId,
      },
    );
    expect(directlyExpiredResponse.status).toBe(400);
    expect(deletePgSession).toHaveBeenCalledWith(
      'responses',
      directlyExpiredId,
    );

    const expiredId = 'resp_expired';
    pgSessions.set(expiredId, {
      accessKeyId: null,
      createdAt: Date.now() - 60 * 60 * 1000 - 1,
      defaults: { instructions: null, tools: [] },
      id: expiredId,
      model: 'gpt-5.5',
      transcript: [],
    });

    const pruneResponse = await handleResponsesRequest(makeRequest(), {
      input: 'trigger prune',
      model: 'gpt-5.5',
    });
    expect((await pruneResponse.json()).output_text).toBe('pruned response');
    expect(deletePgSession).toHaveBeenCalledWith('responses', expiredId);

    const expiredResponse = await handleResponsesRequest(makeRequest(), {
      input: 'expired',
      model: 'gpt-5.5',
      previous_response_id: expiredId,
    });
    expect(expiredResponse.status).toBe(400);
    expect(deletePgSession).toHaveBeenCalledWith('responses', expiredId);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('prunes expired PostgreSQL sessions before enforcing the byte budget', async () => {
    const expiredContent = 'x'.repeat(8 * 1024 * 1024);
    const expiredCreatedAt = Date.now() - 60 * 60 * 1000 - 1;
    Array.from({ length: 9 }).forEach((_, index) => {
      const id = `resp_expired_${index}`;
      pgSessions.set(id, {
        accessKeyId: null,
        createdAt: expiredCreatedAt,
        defaults: { instructions: null, tools: [] },
        id,
        model: 'gpt-5.5',
        transcript: [{ content: expiredContent, role: 'assistant' }],
      });
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeChatResponse('pruned response'),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'trigger byte-budget prune',
      model: 'gpt-5.5',
    });

    expect(response.status).toBe(200);
    expect(deletePgSession).toHaveBeenCalledTimes(9);
    expect(pgSessions.size).toBe(1);
  });

  it('completes the stream when session persistence fails', async () => {
    writePgSession.mockRejectedValueOnce(new Error('database unavailable'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'storage failure',
      model: 'gpt-5.5',
      stream: true,
    });
    const text = await response.text();

    expect(text).toContain('response.error');
    expect(text).toContain('data: [DONE]');
  });

  it('starts a truncated transcript at a complete tool turn', async () => {
    const previousId = 'resp_tool_boundary';
    pgSessions.set(previousId, {
      accessKeyId: null,
      createdAt: Date.now(),
      defaults: { instructions: null, tools: [] },
      id: previousId,
      model: 'gpt-5.5',
      transcript: [
        { content: '{}', role: 'tool', tool_call_id: 'call-orphan' },
        { content: 'continue', role: 'user' },
      ],
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeChatResponse('continued'));

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'continue safely',
      model: 'gpt-5.5',
      previous_response_id: previousId,
    });
    expect(response.status).toBe(200);
    const requestBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string }> };
    expect(requestBody.messages[0]?.role).toBe('user');
  });

  it('does not persist an oversized response session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeChatResponse('x'.repeat(9 * 1024 * 1024)),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'large output',
      model: 'gpt-5.5',
    });

    expect(response.status).toBe(413);
    expect(writePgSession).not.toHaveBeenCalled();
  });

  it('bounds incomplete SSE frames in every proxy stream', async () => {
    const oversizedFrame = 'x'.repeat(1_000_001);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          `${oversizedFrame}\n\ndata: {"choices":[{"delta":{"content":"responses"}}]}`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `${oversizedFrame}\n\ndata: {"id":"chatcmpl_anthropic","model":"gpt-5.5","choices":[{"delta":{"content":"anthropic"}}]}\n\ndata: [DONE]`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `${oversizedFrame}\n\ndata: {"id":"chatcmpl_chat","model":"gpt-5.5","choices":[{"delta":{"content":"chat"}}]}\n\ndata: [DONE]`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(makeChunkedResponse(oversizedFrame))
      .mockResolvedValueOnce(
        makeChunkedResponse(
          `${oversizedFrame}\n\ndata: {"choices":[{"delta":{"content":"complete"}}]}\n\n`,
        ),
      );

    const responsesStream = await handleResponsesRequest(makeRequest(), {
      input: 'stream responses',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await responsesStream.text()).toContain('"output_text":"responses"');

    const anthropicStream = await handleMessagesRequest(
      new NextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 32,
        messages: [{ content: 'stream anthropic', role: 'user' }],
        model: 'gpt-5.5',
        stream: true,
      },
    );
    expect(await anthropicStream.text()).toContain('"text":"anthropic"');

    const credential = (await listCredentials()).credentials[0];
    const context = await resolveProxyContextByCredentialFilename(
      String(credential?.filename),
    );
    const chatStream = await proxyChatCompletions(
      new NextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ content: 'stream chat', role: 'user' }],
        model: 'gpt-5.5',
        stream: true,
      },
      context,
    );
    expect(await chatStream.text()).toContain('"content":"chat"');

    const passthroughStream = await proxyResponsesUpstream(makeRequest(), {
      input: 'stream passthrough',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await passthroughStream.text()).toContain('response.completed');

    const oversizedRemainder = await handleResponsesRequest(makeRequest(), {
      input: 'oversized remainder',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await oversizedRemainder.text()).toContain('response.completed');

    const oversizedComplete = await handleResponsesRequest(makeRequest(), {
      input: 'oversized complete frame',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await oversizedComplete.text()).toContain('"complete"');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('rejects streamed output and tool arguments above their limits', async () => {
    const oversizedText = [
      'x'.repeat(900_000),
      'x'.repeat(900_000),
      'x'.repeat(300_001),
    ];
    const oversizedArguments = ['x'.repeat(900_000), 'x'.repeat(100_001)];
    const aggregateToolCalls = Array.from({ length: 75 }, (_, index) => ({
      function: { arguments: 'x'.repeat(900_000) },
      index,
    }));
    const aggregateToolPayload = aggregateToolCalls
      .map(
        (toolCall) =>
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n`,
      )
      .join('');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          `data: {"choices":[{"delta":{"content":"${oversizedText[0]}"}}]}\n\ndata: {"choices":[{"delta":{"content":"${oversizedText[1]}"}}]}\n\ndata: {"choices":[{"delta":{"content":"${oversizedText[2]}"}}]}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${oversizedArguments[0]}"}}]}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${oversizedArguments[1]}"}}]}}]}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(aggregateToolPayload, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );

    const textResponse = await handleResponsesRequest(makeRequest(), {
      input: 'oversized output',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await textResponse.text()).toContain('response.error');

    const argumentResponse = await handleResponsesRequest(makeRequest(), {
      input: 'oversized arguments',
      model: 'gpt-5.5',
      stream: true,
    });
    expect(await argumentResponse.text()).toContain('response.error');

    const aggregateArgumentResponse = await handleResponsesRequest(
      makeRequest(),
      {
        input: 'aggregate oversized arguments',
        model: 'gpt-5.5',
        stream: true,
      },
    );
    expect(await aggregateArgumentResponse.text()).toContain('response.error');
  });

  it('retains tool argument deltas until an unnamed streaming tool is finalized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'stream anonymous tool',
      model: 'gpt-5.5',
      stream: true,
    });
    const text = await response.text();

    expect(text).toContain('"name":"function"');
    expect(text).toContain('"arguments":"{}"');
    expect(text).toContain('response.function_call_arguments.done');
  });

  it('rejects unbounded streamed tool names and stops processing the frame batch', async () => {
    const oversizedName = 'x'.repeat(257);
    const trailingContent = 'should not be emitted';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: oversizedName } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: trailingContent } }] })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'oversized tool name',
      model: 'gpt-5.5',
      stream: true,
    });
    const text = await response.text();

    expect(text).toContain('response.error');
    expect(text).not.toContain(trailingContent);
  });

  it('emits argument deltas after a streaming tool call is registered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_registered","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'stream registered tool',
      model: 'gpt-5.5',
      stream: true,
    });

    expect(await response.text()).toContain(
      'response.function_call_arguments.delta',
    );
  });
});
