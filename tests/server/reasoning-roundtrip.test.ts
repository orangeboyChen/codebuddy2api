import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { addCredential } from '@/lib/server/domain/credentials';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { sealReasoning } from '@/lib/server/shared/reasoning-seal';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-reasoning-roundtrip');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true });
};

const makeAnthropicRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/messages', { method: 'POST' });

const makeResponsesRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/responses', { method: 'POST' });

const chatResponse = (content: string, reasoning?: string): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
        },
      ],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

/** Captures the body we send upstream, so tests assert on the real payload. */
const captureUpstreamBody = async (
  send: () => Promise<unknown>,
  upstream: Response = chatResponse('the answer'),
): Promise<Record<string, unknown> | undefined> => {
  let captured: Record<string, unknown> | undefined;
  const original = globalThis.fetch;

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [, init] = args;

    if (init?.body && typeof init.body === 'string') {
      try {
        captured = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // Not JSON — ignore.
      }
    }

    return upstream;
  }) as typeof fetch;

  try {
    await send();
  } finally {
    globalThis.fetch = original;
  }

  return captured;
};

interface UpstreamMessage {
  role?: string;
  content?: unknown;
  reasoning?: string;
}

const upstreamMessages = (
  body: Record<string, unknown> | undefined,
): UpstreamMessage[] => (body?.messages ?? []) as UpstreamMessage[];

describe('reasoning round trip', () => {
  const originalKey = process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;

  beforeEach(() => {
    cleanupTempState();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_CONFIG_PATH = '.codebuddy_data/runtime.json';
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'roundtrip-test-secret';
    addCredential({
      bearer_token: 'roundtrip-token',
      responses_passthrough: false,
      user_id: 'roundtrip@example.com',
    });
  });

  afterEach(() => {
    cleanupTempState();

    if (originalKey === undefined) {
      delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    } else {
      process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = originalKey;
    }
  });

  describe('claude code (/v1/messages)', () => {
    it('emits a signature so the thinking block is replayable', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        chatResponse('the answer', 'the model reasoned about primes')) as never;

      let content: Array<Record<string, unknown>> = [];
      try {
        const response = await handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [{ content: 'hi', role: 'user' }],
          model: 'claude-sonnet-4-5',
        } as never);
        const json = (await response.json()) as {
          content?: Array<Record<string, unknown>>;
        };
        content = json.content ?? [];
      } finally {
        globalThis.fetch = original;
      }

      const thinking = content.find((block) => block.type === 'thinking');

      expect(thinking?.thinking).toBe('the model reasoned about primes');
      expect(typeof thinking?.signature).toBe('string');
      expect(thinking?.signature).toBeTruthy();
    });

    it('recovers replayed reasoning and sends it upstream', async () => {
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                { thinking: 'Claude Code replays this', type: 'thinking' },
                { text: 'the answer', type: 'text' },
              ],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.content).toBe('the answer');
      expect(assistant?.reasoning).toBe('Claude Code replays this');
    });

    it('prefers the sealed signature but falls back to the summary', async () => {
      // A client may replay a genuine Anthropic signature from a session it
      // started against real Claude. We cannot open those, and discarding the
      // summary over that would lose perfectly good reasoning — so the
      // signature is preferred when valid, never a gate on the fallback.
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                {
                  signature: 'WaUjzkypQ2mUEVM36O2Txu....',
                  thinking: 'summary text',
                  type: 'thinking',
                },
                { text: 'the answer', type: 'text' },
              ],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBe('summary text');
    });

    it('prefers the signature over the summary when it opens', async () => {
      const sealed = sealReasoning('verbatim reasoning from the signature');

      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                {
                  signature: sealed,
                  thinking: 'a shorter summary',
                  type: 'thinking',
                },
                { text: 'the answer', type: 'text' },
              ],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBe(
        'verbatim reasoning from the signature',
      );
    });

    it('carries an omitted-display block whose summary is empty', async () => {
      // Under `display: "omitted"` the thinking field is empty and the
      // signature is the only payload. Replaying it must still work.
      const sealed = sealReasoning('reasoning hidden from display');

      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                { signature: sealed, thinking: '', type: 'thinking' },
                { text: 'the answer', type: 'text' },
              ],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBe('reasoning hidden from display');
    });

    it('no longer leaks redacted_thinking into the message body', async () => {
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                { data: 'OPAQUE_ENCRYPTED_PAYLOAD', type: 'redacted_thinking' },
                { text: 'the answer', type: 'text' },
              ],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.content).toBe('the answer');
      expect(JSON.stringify(assistant?.content)).not.toContain(
        'redacted_thinking',
      );
    });

    it('stays silent when there is no reasoning to replay', async () => {
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [{ text: 'the answer', type: 'text' }],
              role: 'assistant',
            },
            { content: 'and then?', role: 'user' },
          ],
          model: 'claude-sonnet-4-5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBeUndefined();
    });
  });

  describe('codex (/v1/responses)', () => {
    it('emits a replayable reasoning item', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        chatResponse('the answer', 'codex upstream reasoning')) as never;

      let output: Array<Record<string, unknown>> = [];
      try {
        const response = await handleResponsesRequest(makeResponsesRequest(), {
          input: 'hi',
          model: 'gpt-5.5',
        } as never);
        const json = (await response.json()) as {
          output?: Array<Record<string, unknown>>;
        };
        output = json.output ?? [];
      } finally {
        globalThis.fetch = original;
      }

      const reasoning = output.find((item) => item.type === 'reasoning');

      expect(reasoning).toBeDefined();
      expect(reasoning?.id).toBeTruthy();
      expect(typeof reasoning?.encrypted_content).toBe('string');
    });

    it('attaches replayed reasoning to the assistant turn instead of an empty user turn', async () => {
      const body = await captureUpstreamBody(() =>
        handleResponsesRequest(makeResponsesRequest(), {
          input: [
            { role: 'user', content: 'what is the weather?' },
            {
              id: 'rs_1',
              summary: [{ type: 'summary_text', text: 'check the weather' }],
              type: 'reasoning',
            },
            { role: 'assistant', content: 'checking' },
            { role: 'user', content: 'and tomorrow?' },
          ],
          model: 'gpt-5.5',
        } as never),
      );

      const messages = upstreamMessages(body);

      // The bug this fixes: the reasoning item used to become an extra
      // `{"role":"user","content":""}` turn, which accumulated every round.
      expect(messages.filter((m) => m.content === '')).toHaveLength(0);

      const assistant = messages.find((m) => m.role === 'assistant');

      expect(assistant?.reasoning).toBe('check the weather');
    });

    it('drops a reasoning item that carries nothing recoverable', async () => {
      const body = await captureUpstreamBody(() =>
        handleResponsesRequest(makeResponsesRequest(), {
          input: [
            { role: 'user', content: 'hi' },
            { id: 'rs_2', type: 'reasoning' },
            { role: 'assistant', content: 'the answer' },
          ],
          model: 'gpt-5.5',
        } as never),
      );

      const messages = upstreamMessages(body);

      expect(messages).toHaveLength(2);
      expect(messages.filter((m) => m.content === '')).toHaveLength(0);
    });
  });
});
