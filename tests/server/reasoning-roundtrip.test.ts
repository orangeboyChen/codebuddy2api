import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { addCredential } from '@/lib/server/domain/credentials';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';

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

const makeSseResponse = (frames: string[]): Response =>
  new Response(frames.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });

interface CompletedOutputItem {
  type?: string;
  encrypted_content?: string;
  summary?: Array<{ text?: string }>;
}

/** Pulls the `response.completed` payload out of an SSE stream. */
const extractCompletedResponse = (
  payload: string,
): { output?: CompletedOutputItem[] } | undefined => {
  for (const line of payload.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }

    try {
      const event = JSON.parse(line.slice(6)) as {
        type?: string;
        response?: { output?: CompletedOutputItem[] };
      };

      if (event.type === 'response.completed') {
        return event.response;
      }
    } catch {
      // Ignore keepalives and non-JSON frames.
    }
  }

  return undefined;
};

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
    it('emits the upstream reasoning as a thinking block', async () => {
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
      // No signature: it would duplicate this text on the wire. See
      // `buildThinkingBlock` in the proxy.
      expect(thinking?.signature).toBeUndefined();
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

    it('does not forward a signature it did not mint', async () => {
      // A client may replay a genuine Anthropic signature from a session it
      // started against real Claude. That value is ciphertext we cannot read,
      // and forwarding it upstream would put gibberish where reasoning
      // belongs — so it is skipped and the summary carries the reasoning.
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

    it('ignores a signature in favour of the thinking text', async () => {
      // We never mint signatures on this path, so any signature — even one
      // shaped like ours — is not ours to interpret. The `thinking` field is
      // what carries the reasoning.
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                {
                  signature: 'cbreason1:not from us',
                  thinking: 'the real reasoning',
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

      expect(assistant?.reasoning).toBe('the real reasoning');
    });

    it('drops a block that carries no reasoning', async () => {
      // An omitted-display block has empty `thinking`, so there is nothing to
      // recover and no reasoning should reach the upstream.
      const body = await captureUpstreamBody(() =>
        handleMessagesRequest(makeAnthropicRequest(), {
          max_tokens: 100,
          messages: [
            { content: 'hi', role: 'user' },
            {
              content: [
                {
                  signature: 'cbreason1:reasoning hidden from display',
                  thinking: '',
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

      expect(assistant?.reasoning).toBeUndefined();
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

    it('does not forward an encrypted_content it did not mint', async () => {
      // An OpenAI-issued blob is ciphertext we cannot read. Forwarding it
      // upstream would send gibberish where reasoning belongs, so the summary
      // is used instead — the same rule the Anthropic path follows.
      const body = await captureUpstreamBody(() =>
        handleResponsesRequest(makeResponsesRequest(), {
          input: [
            { role: 'user', content: 'hi' },
            {
              id: 'rs_ext',
              encrypted_content: 'gAAAAABoISQ24OyVRYbkYfukdJoqdzWT...',
              summary: [{ type: 'summary_text', text: 'from the summary' }],
              type: 'reasoning',
            },
            { role: 'assistant', content: 'the answer' },
          ],
          model: 'gpt-5.5',
        } as never),
      );

      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBe('from the summary');
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

    it('emits a replayable reasoning item in the streamed completed output', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"c1","choices":[{"delta":{"reasoning_content":"thinking hard"}}]}',
          'data: {"id":"c1","choices":[{"delta":{"content":"the answer"}}]}',
          'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ]),
      );

      const response = await handleResponsesRequest(makeResponsesRequest(), {
        input: 'hi',
        model: 'gpt-5.5',
        stream: true,
      } as never);

      const payload = await response.text();
      const completed = extractCompletedResponse(payload);

      expect(completed).toBeDefined();

      const reasoning = completed?.output?.find(
        (item) => item.type === 'reasoning',
      );

      // Without this the only reasoning a streaming client ever sees is a
      // transient delta — nothing it can send back on the next turn.
      expect(reasoning).toBeDefined();
      expect(typeof reasoning?.encrypted_content).toBe('string');
      expect(reasoning?.summary?.[0]?.text).toBe('thinking hard');
    });

    it('orders the streamed reasoning item before the message', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        makeSseResponse([
          'data: {"id":"c1","choices":[{"delta":{"reasoning_content":"think first"}}]}',
          'data: {"id":"c1","choices":[{"delta":{"content":"then answer"}}]}',
          'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ]),
      );

      const response = await handleResponsesRequest(makeResponsesRequest(), {
        input: 'hi',
        model: 'gpt-5.5',
        stream: true,
      } as never);

      const completed = extractCompletedResponse(await response.text());
      const types = completed?.output?.map((item) => item.type) ?? [];

      // A client replays `output` verbatim, so reasoning has to precede the
      // message it produced or the replayed turn is scrambled.
      expect(types.indexOf('reasoning')).toBeLessThan(types.indexOf('message'));
    });

    it('persists reasoning so a previous_response_id continuation keeps it', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'the answer',
                  reasoning_content: 'reasoning to persist',
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const first = await handleResponsesRequest(makeResponsesRequest(), {
        input: 'hi',
        model: 'gpt-5.5',
      } as never);
      const firstJson = (await first.json()) as { id?: string };

      const body = await captureUpstreamBody(
        () =>
          handleResponsesRequest(makeResponsesRequest(), {
            input: [{ role: 'user', content: 'and then?' }],
            model: 'gpt-5.5',
            previous_response_id: firstJson.id,
          } as never),
        chatResponse('follow-up'),
      );

      // The client never replayed `output`, so the session is the only thing
      // that can carry the reasoning into this turn.
      const assistant = upstreamMessages(body).find(
        (m) => m.role === 'assistant',
      );

      expect(assistant?.reasoning).toBe('reasoning to persist');
    });
  });
});
