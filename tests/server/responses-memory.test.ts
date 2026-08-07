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
      .mockResolvedValueOnce(makeChatResponse('follow-up response'));

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

    const expiredId = 'resp_expired';
    pgSessions.set(expiredId, {
      accessKeyId: null,
      createdAt: Date.now() - 60 * 60 * 1000 - 1,
      defaults: { instructions: null, tools: [] },
      id: expiredId,
      model: 'gpt-5.5',
      transcript: [],
    });

    const expiredResponse = await handleResponsesRequest(makeRequest(), {
      input: 'expired',
      model: 'gpt-5.5',
      previous_response_id: expiredId,
    });
    expect(expiredResponse.status).toBe(400);
    expect(deletePgSession).toHaveBeenCalledWith('responses', expiredId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not persist an oversized response session', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeChatResponse('x'.repeat(9 * 1024 * 1024)),
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'large output',
      model: 'gpt-5.5',
    });

    expect(response.status).toBe(200);
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
});
