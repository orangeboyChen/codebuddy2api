import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import type { AnthropicTool } from '@/lib/server/proxy/anthropic/types';
import { resetWebSearchProviders } from '@/lib/server/search';
import {
  expectAnthropicContentBlock,
  expectAnthropicEventSequence,
  expectAnthropicMessage,
  readSseEvents,
  type JsonRecord,
} from './output-conformance';

/**
 * `/v1/messages` output, checked against the Anthropic message object.
 *
 * The risky half is the server-tool turn: a provider-executed search arrives
 * as a `server_tool_use` block paired with a `web_search_tool_result` under
 * the same `srvtoolu_` id, and a client that cannot pair them replays a
 * result with no call — which the API rejects on the next turn.
 */

const SEARXNG_ENV_NAMES = ['SEARXNG_URL', 'SEARXNG_API_KEY'] as const;

const weatherTool = (): AnthropicTool => ({
  description: 'Read the weather for a city.',
  input_schema: { type: 'object' },
  name: 'get_weather',
});

// A provider-executed declaration: the `type` is what marks it as the
// server's to run, so the proxy executes the search instead of handing the
// call back to the client.
const searchDeclaration = (): AnthropicTool => ({
  input_schema: { type: 'object' },
  name: 'web_search',
  type: 'web_search_20250305',
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
  id: 'chatcmpl_conformance',
  usage: {
    completion_tokens: 6,
    prompt_tokens: 12,
    prompt_tokens_details: { cached_tokens: 2 },
    total_tokens: 18,
  },
});

describe('anthropic messages output conformance', () => {
  const tempRootDir = path.join(
    process.cwd(),
    '.tmp-anthropic-conformance-root',
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
    new NextRequest('http://localhost/v1/messages', { method: 'POST' });

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
      bearer_token: 'anthropic-conformance-token',
      responses_passthrough: false,
      user_id: 'anthropic-conformance@example.com',
    });
  });

  afterEach(() => {
    clearSearchEnv();
    cleanupDir();
    vi.restoreAllMocks();
  });

  it('returns a message whose tool_use block the client can answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(weatherCallPayload()) as unknown as Response,
    );

    const response = await handleMessagesRequest(makeRequest(), {
      max_tokens: 512,
      messages: [{ role: 'user', content: 'what is the weather?' }],
      model: 'claude-sonnet-4.6',
      tools: [weatherTool()],
    });

    expect(response.status).toBe(200);
    const message = (await response.json()) as JsonRecord;
    expectAnthropicMessage(message);

    // The client stopped because it wants a tool run, not because it finished.
    expect(message.stop_reason).toBe('tool_use');
    const content = message.content as JsonRecord[];
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      id: 'call_weather_1',
      name: 'get_weather',
      type: 'tool_use',
    });
    // `input` is an object here, not the JSON string the chat protocol uses:
    // a client reads it as the tool's arguments as-is.
    expect(content[0].input).toEqual({ city: 'Shanghai' });
  });

  it('pairs a provider-executed search with the result it produced', async () => {
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
              id: 'chatcmpl_hop_one',
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
              id: 'chatcmpl_hop_two',
              usage: {
                completion_tokens: 9,
                prompt_tokens: 21,
                total_tokens: 30,
              },
            },
      ) as unknown as Response;
    });

    const response = await handleMessagesRequest(makeRequest(), {
      max_tokens: 512,
      messages: [{ role: 'user', content: 'when did it ship?' }],
      model: 'claude-sonnet-4.6',
      tools: [searchDeclaration()],
    });

    const message = (await response.json()) as JsonRecord;
    expectAnthropicMessage(message);

    const content = message.content as JsonRecord[];
    // Prose, the call, its result, then the answer the result produced — the
    // order Anthropic's own server tools use, and the order a client replays.
    expect(content.map((block) => block.type)).toEqual([
      'text',
      'server_tool_use',
      'web_search_tool_result',
      'text',
    ]);

    const call = content[1];
    const result = content[2];
    // The pair is joined by the id: a result whose id matches no call is a
    // reply the API refuses on the next turn.
    expect(result.tool_use_id).toBe(call.id);
    expect(call.name).toBe('web_search');
    expect(call.input).toEqual({ query: 'shipping date' });

    const results = result.content as JsonRecord[];
    expect(results[0]).toMatchObject({
      title: 'Docs',
      type: 'web_search_result',
      url: 'https://docs.test',
    });
    expect(typeof results[0].encrypted_content).toBe('string');

    // The turn is billed for the search it ran.
    expect(message.usage).toMatchObject({
      server_tool_use: { web_search_requests: 1 },
    });
  });

  it('streams a tool call as one block closed before the turn ends', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"Working on it."}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_weather_1","index":0,"type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Sha"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nghai\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]) as unknown as Response,
    );

    const response = await handleMessagesRequest(makeRequest(), {
      max_tokens: 512,
      messages: [{ role: 'user', content: 'what is the weather?' }],
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [weatherTool()],
    });
    const events = readSseEvents(await response.text());

    expectAnthropicEventSequence(events);

    const start = events.find(
      (event) =>
        event.type === 'content_block_start' &&
        (event.content_block as JsonRecord).type === 'tool_use',
    );
    expectAnthropicContentBlock(start?.content_block);

    // The deltas are JSON fragments; joined they have to be the object the
    // client hands to its tool.
    const partialJson = events
      .filter(
        (event) =>
          event.type === 'content_block_delta' &&
          (event.delta as JsonRecord).type === 'input_json_delta',
      )
      .map((event) => String((event.delta as JsonRecord).partial_json));
    expect(JSON.parse(partialJson.join(''))).toEqual({ city: 'Shanghai' });

    const delta = events.at(-2) as JsonRecord;
    expect(delta.type).toBe('message_delta');
    expect((delta.delta as JsonRecord).stop_reason).toBe('tool_use');
  });

  it('streams a server-tool turn with the result after the call', async () => {
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
              id: 'chatcmpl_hop_one',
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
              id: 'chatcmpl_hop_two',
              usage: {
                completion_tokens: 9,
                prompt_tokens: 21,
                total_tokens: 30,
              },
            },
      ) as unknown as Response;
    });

    const response = await handleMessagesRequest(makeRequest(), {
      max_tokens: 512,
      messages: [{ role: 'user', content: 'when did it ship?' }],
      model: 'claude-sonnet-4.6',
      stream: true,
      tools: [searchDeclaration()],
    });
    const events = readSseEvents(await response.text());

    expectAnthropicEventSequence(events);

    const blocks = events
      .filter((event) => event.type === 'content_block_start')
      .map((event) => event.content_block as JsonRecord);

    expect(blocks.map((block) => block.type)).toEqual([
      'text',
      'server_tool_use',
      'web_search_tool_result',
      'text',
    ]);
    // The streamed result answers the streamed call, under the same id the
    // client would have to echo back.
    expect(blocks[2].tool_use_id).toBe(blocks[1].id);
  });
});
