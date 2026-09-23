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
import {
  expectResponsesObject,
  readSseEvents,
  type JsonRecord,
} from './output-conformance';

/**
 * `/v1/responses` output, checked against the Responses object the OpenAI
 * schema describes.
 *
 * The cases are the ones a client cannot recover from when they are wrong:
 * a tool call that comes back as something other than a `function_call` never
 * reaches the client's tool loop, and a provider-executed search that is not
 * announced as a `web_search_call` leaves citations pointing at a source the
 * client never saw requested.
 */

const SEARXNG_ENV_NAMES = ['SEARXNG_URL', 'SEARXNG_API_KEY'] as const;

const weatherTool = (): JsonRecord => ({
  name: 'get_weather',
  parameters: { type: 'object' },
  type: 'function',
});

describe('responses output conformance', () => {
  const tempRootDir = path.join(
    process.cwd(),
    '.tmp-responses-conformance-root',
  );
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const clearSearchEnv = (): void => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }

    resetWebSearchProviders();
  };

  const makeJsonResponse = (payload: JsonRecord): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const makeSseResponse = (frames: string[]): Response =>
    new Response(frames.join('\n\n') + '\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });

  const makeRequest = (): NextRequest =>
    new NextRequest('http://localhost/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer responses-conformance-token' },
    });

  const weatherCallPayload = (): JsonRecord => ({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_weather_1',
              type: 'function',
              function: {
                arguments: '{"city":"Shanghai"}',
                name: 'get_weather',
              },
            },
          ],
        },
      },
    ],
    usage: {
      completion_tokens: 7,
      prompt_tokens: 11,
      prompt_tokens_details: { cache_creation_tokens: 2, cached_tokens: 3 },
      total_tokens: 18,
    },
  });

  const enableSearch = async (): Promise<void> => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
  };

  beforeEach(async () => {
    clearSearchEnv();
    resetCredentialRuntimeState();
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'responses-conformance-token',
      responses_passthrough: false,
      user_id: 'responses-conformance@example.com',
    });
  });

  afterEach(() => {
    clearSearchEnv();
    cleanupDir();
    vi.restoreAllMocks();
  });

  it('returns a response object that carries the required fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(weatherCallPayload()) as unknown as Response,
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      instructions: 'Answer briefly.',
      metadata: { conversation: 'conformance' },
      model: 'glm-5.1',
      tool_choice: 'auto',
      tools: [weatherTool()],
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expectResponsesObject(payload);
    // The request's own settings, readable back off the object a client was
    // handed, rather than dropped on the way through.
    expect(payload.instructions).toBe('Answer briefly.');
    expect(payload.metadata).toEqual({ conversation: 'conformance' });
    expect(payload.tool_choice).toBe('auto');
    expect(payload.tools).toHaveLength(1);
  });

  it('echoes empty settings when the request declared none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'It is warm.', role: 'assistant' },
          },
        ],
        usage: { completion_tokens: 4, prompt_tokens: 9, total_tokens: 13 },
      }) as unknown as Response,
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      model: 'glm-5.1',
    });
    const payload = await response.json();

    expectResponsesObject(payload);
    expect(payload.tools).toEqual([]);
    expect(payload.tool_choice).toBe('auto');
    expect(payload.instructions).toBeNull();
    expect(payload.metadata).toEqual({});
    expect(payload.output_text).toBe('It is warm.');
  });

  it('reports a client tool call as a function_call the client can answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(weatherCallPayload()) as unknown as Response,
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      model: 'glm-5.1',
      tools: [weatherTool()],
    });
    const payload = (await response.json()) as JsonRecord;
    const output = payload.output as JsonRecord[];

    // Nothing to execute here, so the turn is one item: the call, handed back
    // for the client to resolve. A message alongside it would be a claim the
    // model answered instead of asking.
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      arguments: '{"city":"Shanghai"}',
      call_id: 'call_weather_1',
      name: 'get_weather',
      status: 'completed',
      type: 'function_call',
    });
    // The id a client keys its own bookkeeping off.
    expect(String(output[0].id)).toMatch(/^fc_/);
    expect(JSON.parse(String(output[0].arguments))).toEqual({
      city: 'Shanghai',
    });
  });

  it('splits cached and written tokens in the usage breakdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(weatherCallPayload()) as unknown as Response,
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      model: 'glm-5.1',
      tools: [weatherTool()],
    });
    const { usage } = (await response.json()) as JsonRecord;

    expect(usage).toMatchObject({
      input_tokens_details: { cache_write_tokens: 2, cached_tokens: 3 },
      output_tokens: 7,
      total_tokens: 18,
    });
  });

  it('forwards and echoes a request that forbids parallel tool calls', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeJsonResponse(weatherCallPayload()) as unknown as Response,
      );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      model: 'glm-5.1',
      parallel_tool_calls: false,
      tools: [weatherTool()],
    });
    const payload = await response.json();

    // Carried upstream, so the model is asked for one call at a time rather
    // than being free to batch them behind a setting the client never set.
    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as JsonRecord;
    expect(upstreamBody.parallel_tool_calls).toBe(false);
    // And reported back as what the client asked for, not as a default.
    expect(payload.parallel_tool_calls).toBe(false);
    expectResponsesObject(payload);
  });

  it('interleaves a provider-executed search with the prose around it', async () => {
    await enableSearch();
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('searx.test')) {
        return makeJsonResponse({
          results: [
            { content: 'snippet', title: 'Docs', url: 'https://docs.test' },
          ],
        }) as unknown as Response;
      }

      calls += 1;

      return makeJsonResponse(
        calls === 1
          ? {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: 'Let me look that up.',
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'call_search_1',
                        type: 'function',
                        function: {
                          arguments: '{"query":"shipping date"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            }
          : {
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: 'It shipped in March, see https://docs.test',
                    role: 'assistant',
                  },
                },
              ],
              usage: {
                completion_tokens: 9,
                prompt_tokens: 21,
                total_tokens: 30,
              },
            },
      ) as unknown as Response;
    });

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'when did it ship?',
      model: 'glm-5.1',
      tools: [{ type: 'web_search_preview' }],
    });
    const payload = (await response.json()) as JsonRecord;
    expectResponsesObject(payload);

    const output = payload.output as JsonRecord[];
    // Prose, the search it asked for, then the answer the search produced —
    // the order the turn was written in, which is also the order a client
    // replays on the next request.
    expect(output.map((item) => item.type)).toEqual([
      'message',
      'web_search_call',
      'message',
    ]);

    const search = output[1];
    expect(search).toMatchObject({
      action: { query: 'shipping date', type: 'search' },
      status: 'completed',
      type: 'web_search_call',
    });

    const answer = (output[2].content as JsonRecord[])[0];
    const annotations = answer.annotations as JsonRecord[];
    expect(annotations).toHaveLength(1);
    // The cited span is the URL the model wrote, inside the text it is
    // annotating rather than past its end.
    expect(
      String(answer.text).slice(
        annotations[0].start_index as number,
        annotations[0].end_index as number,
      ),
    ).toBe('https://docs.test');
  });

  it('closes every streamed item and agrees with the object it completes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_weather_1","index":0,"type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Sha"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nghai\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]) as unknown as Response,
    );

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'what is the weather?',
      instructions: 'Answer briefly.',
      metadata: { conversation: 'conformance' },
      model: 'glm-5.1',
      stream: true,
      tools: [weatherTool()],
    });
    const events = readSseEvents(await response.text());

    expect(events[0].type).toBe('response.created');
    expectResponsesObject(events[0].response);

    const added = events.filter(
      (event) => event.type === 'response.output_item.added',
    );
    const done = events.filter(
      (event) => event.type === 'response.output_item.done',
    );
    expect(added).toHaveLength(1);
    expect(done).toHaveLength(1);
    // The item is closed under the same id and index it was opened with, or a
    // client pairing the two sees an orphan.
    expect(done[0].item).toMatchObject({
      id: (added[0].item as JsonRecord).id,
    });
    expect(done[0].output_index).toBe(added[0].output_index);

    // The deltas are the only copy of the arguments a client assembling the
    // call has until the item closes, so they have to add up to it.
    const deltas = events
      .filter(
        (event) => event.type === 'response.function_call_arguments.delta',
      )
      .map((event) => String(event.delta));
    const completedItem = done[0].item as JsonRecord;
    expect(deltas.join('')).toBe(String(completedItem.arguments));
    expect(JSON.parse(deltas.join(''))).toEqual({ city: 'Shanghai' });

    const argumentsDone = events.find(
      (event) => event.type === 'response.function_call_arguments.done',
    );
    expect(argumentsDone?.arguments).toBe(completedItem.arguments);

    const completed = events.at(-1) as JsonRecord;
    expect(completed.type).toBe('response.completed');
    expectResponsesObject(completed.response);
    expect(
      (completed.response as JsonRecord).output as JsonRecord[],
    ).toHaveLength(1);
  });

  it('announces the lifecycle of a streamed server-side search', async () => {
    await enableSearch();
    // Clocked forward on every read, so a replay that stamped its own creation
    // time would not land in the same second as the announcement it follows.
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      clock += 5_000;

      return clock;
    });
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('searx.test')) {
        return makeJsonResponse({
          results: [
            { content: 'snippet', title: 'Docs', url: 'https://docs.test' },
          ],
        }) as unknown as Response;
      }

      calls += 1;

      return makeJsonResponse(
        calls === 1
          ? {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: 'Checking.',
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'call_search_1',
                        type: 'function',
                        function: {
                          arguments: '{"query":"shipping date"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            }
          : {
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: 'It shipped in March.',
                    role: 'assistant',
                  },
                },
              ],
              usage: {
                completion_tokens: 9,
                prompt_tokens: 21,
                total_tokens: 30,
              },
            },
      ) as unknown as Response;
    });

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'when did it ship?',
      model: 'glm-5.1',
      stream: true,
      tools: [{ type: 'web_search_preview' }],
    });
    const events = readSseEvents(await response.text());
    const lifecycleTypes = events
      .filter((event) =>
        String(event.type).startsWith('response.web_search_call.'),
      )
      .map((event) => event.type);

    expect(lifecycleTypes).toEqual([
      'response.web_search_call.in_progress',
      'response.web_search_call.searching',
      'response.web_search_call.completed',
    ]);

    const lifecycleItemIds = new Set(
      events
        .filter((event) =>
          String(event.type).startsWith('response.web_search_call.'),
        )
        .map((event) => String(event.item_id)),
    );
    // One search, one id: a client watching for the item it was told about
    // has to see all three events under it.
    expect(lifecycleItemIds.size).toBe(1);

    const completed = events.at(-1) as JsonRecord;
    expect(completed.type).toBe('response.completed');
    expectResponsesObject(completed.response);

    const output = (completed.response as JsonRecord).output as JsonRecord[];
    expect(output.map((item) => item.type)).toEqual([
      'message',
      'web_search_call',
      'message',
    ]);
    expect(String(output[1].id)).toBe([...lifecycleItemIds][0]);
    // The turn ran after the response was announced, so the replay could
    // easily stamp a second, later creation time onto the same id.
    expect((completed.response as JsonRecord).created_at).toBe(
      (events[0].response as JsonRecord).created_at,
    );
  });
});
