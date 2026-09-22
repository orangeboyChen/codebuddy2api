import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateSettings } from '@/lib/server/domain/config';
import { resetCredentialRuntimeState } from '@/lib/server/domain/credentials';
import { createProxyContextFromCredential } from '@/lib/server/proxy/codebuddy';
import { createResponsesEventStream } from '@/lib/server/proxy/responses/event-stream';
import type {
  ResponseSessionDefaults,
  TranscriptMessage,
} from '@/lib/server/proxy/responses/types';
import { resetWebSearchProviders } from '@/lib/server/search';
import { resetStorageRuntime } from '@/lib/server/storage';

/**
 * The two ways a streamed Responses turn can end badly, plus the way a search
 * is authenticated.
 *
 * The turn itself is buffered — every hop has to finish before the proxy knows
 * whether the model wants another search — so this is the stream the client
 * holds while that happens: it is opened with `response.created`, and then
 * either replayed, failed, or abandoned. Those three endings are what is under
 * test here; the happy-path mapping is covered elsewhere.
 */
const { failingReplay, unreadableErrorBody } = vi.hoisted(() => ({
  failingReplay: { message: null as string | null },
  unreadableErrorBody: { value: false },
}));

vi.mock('@/lib/server/proxy/responses/payload', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/server/proxy/responses/payload')
    >();

  return {
    ...actual,
    // Only forced in the one case that needs it; the rest replay for real.
    mapChatResponseToResponsesStream: async (
      ...args: Parameters<typeof actual.mapChatResponseToResponsesStream>
    ): Promise<Response> => {
      if (failingReplay.message) {
        throw new Error(failingReplay.message);
      }

      return await actual.mapChatResponseToResponsesStream(...args);
    },
  };
});

vi.mock('@/lib/server/proxy/anthropic/errors', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/server/proxy/anthropic/errors')
    >();

  return {
    ...actual,
    // Only forced in the one case that needs it.
    getUpstreamErrorMessage: async (response: Response): Promise<string> => {
      if (unreadableErrorBody.value) {
        throw new Error('body is gone');
      }

      return await actual.getUpstreamErrorMessage(response);
    },
  };
});

describe('responses event stream', () => {
  const tempRootDir = path.join(
    process.cwd(),
    '.tmp-responses-event-stream-root',
  );
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  /** The answer the model writes after the search. */
  const ANSWER = 'It shipped yesterday — see https://docs.test/release.';

  const searchCall = {
    function: { arguments: '{"query":"release date"}', name: 'web_search' },
    id: 'call_1',
    type: 'function',
  };

  /** A hop that asks for a search, as a buffered chat payload. */
  const searchHop = {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [searchCall],
        },
      },
    ],
  };

  /** A hop that answers, as a buffered chat payload. */
  const answerHop = (text: string) => ({
    choices: [
      { finish_reason: 'stop', message: { content: text, role: 'assistant' } },
    ],
  });

  /** A hop that asks for an image, as a buffered chat payload. */
  const imageHop = {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: '{"prompt":"a cat"}',
                name: 'image_generation',
              },
              id: 'call_image',
              type: 'function',
            },
          ],
        },
      },
    ],
  };

  /**
   * One hop, as the SSE frames a live upstream sends: the answer spelled as
   * deltas ending in a `finish_reason`.
   */
  const asLiveStream = (text: string): string =>
    [
      `data: ${JSON.stringify({
        choices: [
          { delta: { content: text, role: 'assistant' }, finish_reason: null },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n');

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const makeJsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      status,
    });

  const makeRequest = (): NextRequest =>
    new NextRequest('http://localhost/v1/responses', { method: 'POST' });

  /** A context backed by one credential, without touching credential storage. */
  const proxyContext = () =>
    createProxyContextFromCredential({
      data: {
        bearer_token: 'event-stream-token',
        responses_passthrough: false,
        user_id: 'event-stream@example.test',
      },
      filePath: '/tmp/event-stream.json',
      filename: 'event-stream.json',
    });

  const transcript: TranscriptMessage[] = [
    { content: 'when did it ship?', role: 'user' },
  ];

  const defaults: ResponseSessionDefaults = {
    tools: [{ type: 'web_search_preview' }],
  };

  const startTurn = (
    turnDefaults: ResponseSessionDefaults = defaults,
  ): Promise<Response> =>
    createResponsesEventStream(
      makeRequest(),
      turnDefaults,
      transcript,
      'glm-5.1',
      null,
      undefined,
      proxyContext(),
    );

  /** The events of an SSE body, in the order they were written. */
  const eventsOf = (body: string): Array<Record<string, unknown>> =>
    body
      .split('\n\n')
      .map((block) =>
        block.split('\n').find((segment) => segment.startsWith('data: ')),
      )
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.slice(6).trim())
      .filter((raw) => raw && raw !== '[DONE]')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);

  /** One upstream call, split by which endpoint it went to. */
  const mockUpstream = (
    onChat: (call: number) => { payload: unknown; status?: number },
  ): Array<{ authorization: string | null; url: string }> => {
    const searchRequests: Array<{
      authorization: string | null;
      url: string;
    }> = [];
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.includes('agenttool')) {
          searchRequests.push({
            authorization: new Headers(init?.headers).get('authorization'),
            url,
          });

          return makeJsonResponse({
            results: [
              {
                snippet: 'A snippet',
                title: 'Docs',
                url: 'https://docs.test/release',
              },
            ],
          }) as unknown as Response;
        }

        calls += 1;
        const { payload, status } = onChat(calls);

        return makeJsonResponse(payload, status) as unknown as Response;
      },
    );

    return searchRequests;
  };

  beforeEach(async () => {
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetCredentialRuntimeState();
    resetStorageRuntime();
    resetWebSearchProviders();
    failingReplay.message = null;
    unreadableErrorBody.value = false;
    // The gateway's own search backend: it needs no deployment of its own, and
    // it is the one that authenticates with the credential backing the
    // request — which is the handoff this stream has to make.
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
  });

  afterEach(() => {
    cleanupDir();
    resetWebSearchProviders();
    vi.restoreAllMocks();
  });

  it('maps a live upstream stream when nothing has to run locally', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(asLiveStream('A live answer.'), {
        headers: { 'Content-Type': 'text/event-stream' },
      }) as unknown as Response;
    });

    // No server tool, no image tool: the upstream's stream is mapped one chunk
    // at a time rather than buffered and replayed.
    const body = await (await startTurn({})).text();
    const events = eventsOf(body);

    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => String(event.delta ?? ''))
        .join(''),
    ).toBe('A live answer.');
    expect(
      (
        events.find((event) => event.type === 'response.completed')
          ?.response as { output_text?: string }
      ).output_text,
    ).toBe('A live answer.');
  });

  it('hands the searches the credential backing the request, and replays the turn', async () => {
    const searchRequests = mockUpstream((call) => ({
      payload: call === 1 ? searchHop : answerHop(ANSWER),
    }));

    const response = await startTurn();

    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    const events = eventsOf(body);

    // Reached the backend under the request's own credential, not a token
    // resolved from credential storage.
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0].url).toContain('/agenttool/v1/search');
    expect(searchRequests[0].authorization).toBe('Bearer event-stream-token');

    expect(events.at(0)?.type).toBe('response.created');
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => String(event.delta ?? ''))
        .join(''),
    ).toBe(ANSWER);

    const completed = events.find(
      (event) => event.type === 'response.completed',
    );
    const output = (completed?.response as { output: Array<{ type: string }> })
      .output;

    // The search really ran, so the client is shown the call it paid for.
    expect(output.map((item) => item.type)).toContain('web_search_call');
    expect(body).toContain('data: [DONE]');
  });

  it('replays the upstream error in the upstream words', async () => {
    mockUpstream(() => ({
      payload: { error: { message: 'Rate limit reached, slow down' } },
      status: 429,
    }));

    const body = await (await startTurn()).text();
    const events = eventsOf(body);
    const failed = events.find((event) => event.type === 'response.error');

    expect(failed?.error).toMatchObject({
      message: expect.stringContaining('Rate limit reached'),
    });
    // Closed rather than left open: a client waiting on the stream has to be
    // told the turn is over.
    expect(body).toContain('data: [DONE]');
  });

  it('falls back to a generic message when the error body cannot be read', async () => {
    unreadableErrorBody.value = true;
    mockUpstream(() => ({ payload: {}, status: 503 }));

    const events = eventsOf(await (await startTurn()).text());

    expect(events.find((event) => event.type === 'response.error')).toEqual({
      error: { message: 'Upstream request failed' },
      type: 'response.error',
    });
  });

  it('stops replaying a turn whose client hung up', async () => {
    let releaseUpstream: () => void = () => undefined;
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });

    mockUpstream(() => ({
      payload: answerHop('an answer nobody is waiting for'),
    }));
    vi.mocked(globalThis.fetch).mockImplementation(async () => {
      await upstreamGate;

      return makeJsonResponse(answerHop('late')) as unknown as Response;
    });

    const response = await startTurn();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const opened = decoder.decode((await reader.read()).value);

    // Announced before the turn started, so a client has an id to hang up on.
    expect(opened).toContain('response.created');

    await reader.cancel();
    releaseUpstream();
    // Long enough for the abandoned turn to come back and be dropped.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Nothing more arrives, and the stream is closed rather than errored: a
    // hang-up is the client's choice, not a failure of the turn.
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('drives an image generation through the server-tool turn', async () => {
    let chatCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('/v2/images/generations')) {
          return makeJsonResponse({
            data: [{ b64_json: 'QUJD' }],
          }) as unknown as Response;
        }

        chatCalls += 1;

        return makeJsonResponse(
          chatCalls === 1
            ? {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      content: null,
                      role: 'assistant',
                      tool_calls: [
                        {
                          function: {
                            arguments: '{"prompt":"a cat"}',
                            name: 'image_generation',
                          },
                          id: 'call_image',
                          type: 'function',
                        },
                      ],
                    },
                  },
                ],
              }
            : answerHop('Here is your cat.'),
        ) as unknown as Response;
      },
    );

    const response = await startTurn({
      tools: [{ type: 'web_search_preview' }, { type: 'image_generation' }],
    });

    const body = await response.text();
    const events = eventsOf(body);
    const completed = events.find(
      (event) => event.type === 'response.completed',
    );
    const output = (
      completed?.response as {
        output: Array<Record<string, unknown>>;
      }
    ).output;

    // Generated locally, so the client is handed the image rather than a
    // function call it would have to resolve itself.
    expect(output.map((item) => item.type)).toContain('image_generation_call');
    expect(
      events
        .filter((event) => event.type === 'response.output_text.delta')
        .map((event) => String(event.delta ?? ''))
        .join(''),
    ).toContain('Here is your cat.');
  });

  it('forwards an image-only turn upstream untouched', async () => {
    let chatCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        if (String(input).includes('/v2/images/generations')) {
          return makeJsonResponse({
            data: [{ b64_json: 'QUJD' }],
          }) as unknown as Response;
        }

        chatCalls += 1;

        return makeJsonResponse(
          chatCalls === 1 ? imageHop : answerHop('Here is your cat.'),
        ) as unknown as Response;
      },
    );

    // No server tool declared, so there is no turn to run: the hop goes
    // upstream exactly as the image loop sends it.
    const body = await (
      await startTurn({ tools: [{ type: 'image_generation' }] })
    ).text();
    const output = (
      eventsOf(body).find((event) => event.type === 'response.completed')
        ?.response as { output: Array<Record<string, unknown>> }
    ).output;

    expect(output.map((item) => item.type)).toContain('image_generation_call');
  });

  it('runs a search asked for inside the image loop', async () => {
    let chatCalls = 0;
    const searchRequests: Array<{
      authorization: string | null;
      url: string;
    }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.includes('/v2/images/generations')) {
          return makeJsonResponse({
            data: [{ b64_json: 'QUJD' }],
          }) as unknown as Response;
        }

        if (url.includes('agenttool')) {
          searchRequests.push({
            authorization: new Headers(init?.headers).get('authorization'),
            url,
          });

          return makeJsonResponse({
            results: [
              {
                snippet: 'A snippet',
                title: 'Docs',
                url: 'https://docs.test/release',
              },
            ],
          }) as unknown as Response;
        }

        chatCalls += 1;

        return makeJsonResponse(
          // 1: the model searches. 2: with the findings, it asks for an image.
          // 3: the answer the loop replays.
          chatCalls === 1
            ? searchHop
            : chatCalls === 2
              ? imageHop
              : answerHop('Here is your cat.'),
        ) as unknown as Response;
      },
    );

    const body = await (
      await startTurn({
        tools: [{ type: 'web_search_preview' }, { type: 'image_generation' }],
      })
    ).text();
    const output = (
      eventsOf(body).find((event) => event.type === 'response.completed')
        ?.response as { output: Array<Record<string, unknown>> }
    ).output;

    // The search ran inside the image loop's own hop, under the request's
    // credential — and both calls reach the client.
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0].authorization).toBe('Bearer event-stream-token');
    expect(output.map((item) => item.type)).toContain('web_search_call');
    expect(output.map((item) => item.type)).toContain('image_generation_call');
  });

  it('hands back a failed image turn as the upstream sent it', async () => {
    let chatCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      chatCalls += 1;

      if (chatCalls === 1) {
        return makeJsonResponse(
          { error: { message: 'Upstream is on fire' } },
          503,
        ) as unknown as Response;
      }

      return makeJsonResponse(
        answerHop('never reached'),
      ) as unknown as Response;
    });

    const response = await startTurn({ tools: [{ type: 'image_generation' }] });

    // Not re-issued, and not wrapped: the loop already sent the turn upstream,
    // so its own status and detail are what the client is given.
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).not.toContain(
      'text/event-stream',
    );
  });

  it('surfaces a failure while replaying as a stream error', async () => {
    failingReplay.message = 'the replay exploded';
    mockUpstream(() => ({ payload: answerHop(ANSWER) }));

    const reader = (await startTurn()).body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    await expect(
      (async (): Promise<void> => {
        while (true) {
          const { done, value } = await reader.read();

          if (done) return;

          chunks.push(decoder.decode(value));
        }
      })(),
    ).rejects.toThrow('the replay exploded');

    // The client was already holding the id, so it can be told the turn died
    // rather than being left with a stream that never ends.
    expect(chunks.join('')).toContain('response.created');
  });
});
