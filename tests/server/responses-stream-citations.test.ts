import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { resetWebSearchProviders } from '@/lib/server/search';

/**
 * Citations on a turn the client asked to have streamed.
 *
 * `runServerToolTurn` asks upstream for a buffered answer on every hop, so a
 * server-tool turn is replayed through the buffered mapper rather than mapped
 * one SSE chunk at a time — and the buffered mapper is the one that annotates.
 * These tests pin that a streamed turn cites exactly what a buffered one does.
 */
describe('responses streaming citations', () => {
  const tempRootDir = path.join(
    process.cwd(),
    '.tmp-responses-stream-citations-root',
  );
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const SEARXNG_ENV_NAMES = [
    'SEARXNG_URL',
    'SEARXNG_API_KEY',
    'SEARXNG_ENGINES',
    'SEARXNG_LANGUAGE',
    'SEARXNG_MAX_RESULTS',
    'SEARXNG_TIMEOUT_MS',
  ] as const;

  /** An output item, as far as these tests read it. */
  interface OutputItem {
    content?: Array<{ annotations?: UrlCitation[]; text?: string }>;
    type: string;
  }

  /** A `url_citation`, as the Responses API spells it. */
  interface UrlCitation {
    end_index: number;
    start_index: number;
    title: string;
    type: string;
    url: string;
  }

  /** The terminal event of a streamed turn, as far as these tests read it. */
  interface CompletedResponse {
    output: OutputItem[];
    output_text: string;
  }

  const clearSearxngEnv = (): void => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }

    resetWebSearchProviders();
  };

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const makeResponse = (
    body: string,
    contentType: string,
    status = 200,
  ): Response =>
    new Response(body, { headers: { 'Content-Type': contentType }, status });

  const makeJsonResponse = (
    payload: Record<string, unknown>,
    status = 200,
  ): Response =>
    makeResponse(JSON.stringify(payload), 'application/json', status);

  const makeRequest = (): NextRequest =>
    new NextRequest('http://localhost/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer responses-stream-citations-token' },
    });

  const enableSearch = async (): Promise<void> => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
  };

  /** One SSE frame, as the chat upstream spells it. */
  const frame = (chunk: Record<string, unknown>): string =>
    `data: ${JSON.stringify(chunk)}`;

  const searchCall = {
    function: { arguments: '{"query":"release date"}', name: 'web_search' },
    id: 'call_1',
    type: 'function',
  };

  /** A hop that asks for a search, as a buffered chat payload. */
  const searchHop = (content: string | null) => ({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { content, role: 'assistant', tool_calls: [searchCall] },
      },
    ],
  });

  /** A hop that answers, as a buffered chat payload. */
  const answerHop = (text: string) => ({
    choices: [
      { finish_reason: 'stop', message: { content: text, role: 'assistant' } },
    ],
  });

  /**
   * One hop, as the SSE frames an upstream that ignored `stream: false` would
   * send: the same message, spelled as deltas ending in a `finish_reason`.
   */
  const asSseBody = (
    content: string | null,
    toolCalls: Array<Record<string, unknown>>,
    finishReason: string,
  ): string =>
    [
      frame({
        choices: [
          { delta: { content, role: 'assistant' }, finish_reason: null },
        ],
      }),
      ...(toolCalls.length
        ? [
            frame({
              choices: [
                {
                  delta: { tool_calls: toolCalls },
                  finish_reason: finishReason,
                },
              ],
            }),
          ]
        : [frame({ choices: [{ delta: {}, finish_reason: finishReason }] })]),
      'data: [DONE]',
      '',
    ].join('\n\n');

  interface TurnOptions {
    answer: string;
    /**
     * How upstream labels the body of a hop it was asked not to stream.
     *
     * `application/json` is what an upstream that honours `stream: false`
     * returns. `text/event-stream` is the one way a buffered turn could reach
     * the chunk-by-chunk mapper, which reads only the label to pick itself —
     * and which finds no `data:` frames in a JSON body, so it would answer
     * with an empty `output_text` rather than merely an unannotated one.
     */
    hopContentType?: 'application/json' | 'text/event-stream';
    /** Text the model writes before it searches, when it writes any. */
    preamble?: string;
    results: Array<Record<string, unknown>>;
    stream?: boolean;
  }

  /**
   * One turn: the model asks for a search, the proxy serves `results`, and the
   * model answers with `answer`.
   *
   * Returns the response body — SSE when the client asked to stream, JSON
   * otherwise.
   */
  const runTurn = async ({
    answer,
    hopContentType = 'application/json',
    preamble,
    results,
    stream = false,
  }: TurnOptions): Promise<string> => {
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({ results }) as unknown as Response;
      }

      calls += 1;
      const isSearchHop = calls === 1;

      if (hopContentType === 'text/event-stream') {
        return makeResponse(
          isSearchHop
            ? asSseBody(
                preamble ?? null,
                [{ ...searchCall, index: 0 }],
                'tool_calls',
              )
            : asSseBody(answer, [], 'stop'),
          'text/event-stream',
        ) as unknown as Response;
      }

      return makeJsonResponse(
        isSearchHop ? searchHop(preamble ?? null) : answerHop(answer),
      ) as unknown as Response;
    });

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'when did it ship?',
      model: 'glm-5.1',
      ...(stream ? { stream: true } : {}),
      tools: [{ type: 'web_search_preview' }],
    });

    return response.text();
  };

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

  /** The `response.completed` payload of a streamed turn. */
  const completedOf = (body: string): CompletedResponse => {
    const event = eventsOf(body).find(
      (item) => item.type === 'response.completed',
    );

    if (!event) {
      throw new Error(`no response.completed in:\n${body}`);
    }

    return event.response as CompletedResponse;
  };

  /** Every assistant message of a completed turn, in the order written. */
  const messagesOf = (response: CompletedResponse): OutputItem[] =>
    response.output.filter((item) => item.type === 'message');

  /** The annotations on one message; the last one unless told otherwise. */
  const annotationsOf = (
    response: CompletedResponse,
    messageIndex = -1,
  ): UrlCitation[] =>
    messagesOf(response).at(messageIndex)?.content?.[0]?.annotations ?? [];

  const ANSWER =
    'It shipped yesterday — see https://docs.test/release for notes.';
  const RESULTS = [
    { content: 'A snippet', title: 'Docs', url: 'https://docs.test/release' },
  ];
  const CITATION: UrlCitation = {
    end_index: 'It shipped yesterday — see https://docs.test/release'.length,
    start_index: 'It shipped yesterday — see '.length,
    title: 'Docs',
    type: 'url_citation',
    url: 'https://docs.test/release',
  };

  beforeEach(async () => {
    clearSearxngEnv();
    resetCredentialRuntimeState();
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'responses-stream-citations-token',
      responses_passthrough: false,
      user_id: 'responses-stream-citations@example.com',
    });
  });

  afterEach(() => {
    clearSearxngEnv();
    cleanupDir();
    vi.restoreAllMocks();
  });

  it('cites the quoted result on a streamed turn exactly as on a buffered one', async () => {
    await enableSearch();

    const streamed = completedOf(
      await runTurn({ answer: ANSWER, results: RESULTS, stream: true }),
    );
    const buffered = JSON.parse(
      await runTurn({ answer: ANSWER, results: RESULTS }),
    ) as CompletedResponse;

    expect(annotationsOf(streamed)).toEqual([CITATION]);
    expect(annotationsOf(streamed)).toEqual(annotationsOf(buffered));
    // The turn really was a server-tool turn, so a client can trace the
    // citation back to a search it was shown.
    expect(streamed.output.map((item) => item.type)).toContain(
      'web_search_call',
    );
  });

  it('replays the answer as text deltas, and the citation with the item it closes', async () => {
    await enableSearch();

    const events = eventsOf(
      await runTurn({ answer: ANSWER, results: RESULTS, stream: true }),
    );
    const deltas = events
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => String(event.delta ?? ''));

    expect(deltas.join('')).toBe(ANSWER);

    const closedMessage = events
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => event.item as OutputItem)
      .find((item) => item.type === 'message');

    // The client renders against the item it keeps, so that is where the
    // annotation has to be — not only on the terminal event.
    expect(closedMessage?.content?.[0]?.annotations).toEqual([CITATION]);
  });

  it('leaves the preamble unannotated on a streamed turn', async () => {
    await enableSearch();

    const streamed = completedOf(
      await runTurn({
        answer: 'Here is what I found: https://docs.test/release.',
        preamble: 'Let me check https://docs.test/release.',
        results: RESULTS,
        stream: true,
      }),
    );
    const messages = messagesOf(streamed);

    expect(messages).toHaveLength(2);
    // Prose written before the search cannot cite it, even when it quotes a
    // URL that later turns out to be a result.
    expect(annotationsOf(streamed, 0)).toEqual([]);
    expect(annotationsOf(streamed)).toHaveLength(1);
  });

  it('annotates nothing when the model quoted no result', async () => {
    await enableSearch();

    const streamed = completedOf(
      await runTurn({
        answer: 'It shipped yesterday, apparently.',
        results: RESULTS,
        stream: true,
      }),
    );

    expect(streamed.output.map((item) => item.type)).toContain(
      'web_search_call',
    );
    expect(annotationsOf(streamed)).toEqual([]);
  });

  /**
   * The invariant that keeps the chunk-by-chunk mapper off this path.
   *
   * `isEventStream` reads only the content type, and a hop's body is
   * re-serialized as JSON before it is handed on — so an upstream that
   * answers a buffered hop with an SSE label is the one way a streamed
   * server-tool turn could reach that mapper, which finds no `data:` frames
   * in a JSON body and would drop the answer whole.
   */
  it('still cites when the upstream labels a buffered hop as an event stream', async () => {
    await enableSearch();

    const streamed = completedOf(
      await runTurn({
        answer: ANSWER,
        hopContentType: 'text/event-stream',
        results: RESULTS,
        stream: true,
      }),
    );

    expect(streamed.output_text).toBe(ANSWER);
    expect(annotationsOf(streamed)).toEqual([CITATION]);
  });
});
