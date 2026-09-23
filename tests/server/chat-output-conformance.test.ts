import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import { expectChatCompletion, type JsonRecord } from './output-conformance';

/**
 * `/v1/chat/completions` output, checked against the chat completion object.
 *
 * The answers here are the upstream's own, so what is being asserted is that
 * the proxy hands them on in the shape the chat protocol defines — including
 * the case where upstream answered with a stream the caller never asked for
 * and the proxy has to assemble the object itself. A tool call assembled
 * wrong is a tool call no client can dispatch.
 */

const chatTool = (): JsonRecord => ({
  function: {
    name: 'get_weather',
    parameters: { type: 'object' },
  },
  type: 'function',
});

const completionWithToolCall = (): JsonRecord => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      index: 0,
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
  created: 1_700_000_000,
  id: 'chatcmpl_conformance',
  model: 'glm-5.1',
  object: 'chat.completion',
  usage: {
    completion_tokens: 6,
    prompt_tokens: 12,
    total_tokens: 18,
  },
});

describe('chat completions output conformance', () => {
  const tempRootDir = path.join(process.cwd(), '.tmp-chat-conformance-root');
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
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
    new NextRequest('http://localhost/v1/chat/completions', { method: 'POST' });

  beforeEach(async () => {
    resetCredentialRuntimeState();
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'chat-conformance-token',
      responses_passthrough: false,
      user_id: 'chat-conformance@example.com',
    });
  });

  afterEach(() => {
    cleanupDir();
    vi.restoreAllMocks();
  });

  it('hands a non-streaming tool call back in the chat object', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(completionWithToolCall()) as unknown as Response,
    );

    const response = await proxyChatCompletions(makeRequest(), {
      messages: [{ role: 'user', content: 'what is the weather?' }],
      model: 'glm-5.1',
      tools: [chatTool()],
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as JsonRecord;
    expectChatCompletion(payload);

    const choice = (payload.choices as JsonRecord[])[0];
    expect(choice.finish_reason).toBe('tool_calls');
    const toolCall = (
      (choice.message as JsonRecord).tool_calls as JsonRecord[]
    )[0];
    expect(toolCall).toMatchObject({
      id: 'call_weather_1',
      type: 'function',
    });
    expect(
      JSON.parse(String((toolCall.function as JsonRecord).arguments)),
    ).toEqual({ city: 'Shanghai' });
  });

  it('assembles a chat object when upstream streamed anyway', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse([
        'data: {"choices":[{"delta":{"role":"assistant","content":null}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Shang"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hai\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]) as unknown as Response,
    );

    const response = await proxyChatCompletions(makeRequest(), {
      messages: [{ role: 'user', content: 'what is the weather?' }],
      model: 'glm-5.1',
      tools: [chatTool()],
    });

    const payload = (await response.json()) as JsonRecord;
    expectChatCompletion(payload);
    expect(payload.object).toBe('chat.completion');

    const choice = (payload.choices as JsonRecord[])[0];
    expect(choice.finish_reason).toBe('tool_calls');
    const toolCall = (
      (choice.message as JsonRecord).tool_calls as JsonRecord[]
    )[0];
    // The fragments upstream sent have to arrive as one call with one set of
    // arguments, or the client's tool is handed half an object.
    expect(toolCall).toMatchObject({
      id: 'call_weather_1',
      type: 'function',
    });
    expect(
      JSON.parse(String((toolCall.function as JsonRecord).arguments)),
    ).toEqual({ city: 'Shanghai' });
  });

  it('streams tool calls as chunks a client can concatenate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse([
        'data: {"id":"chatcmpl_conformance","object":"chat.completion.chunk","created":1700000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}',
        'data: {"id":"chatcmpl_conformance","object":"chat.completion.chunk","created":1700000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_weather_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}',
        'data: {"id":"chatcmpl_conformance","object":"chat.completion.chunk","created":1700000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Shang"}}]}}]}',
        'data: {"id":"chatcmpl_conformance","object":"chat.completion.chunk","created":1700000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hai\\"}"}}]}}]}',
        'data: {"id":"chatcmpl_conformance","object":"chat.completion.chunk","created":1700000000,"model":"glm-5.1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]) as unknown as Response,
    );

    const response = await proxyChatCompletions(makeRequest(), {
      messages: [{ role: 'user', content: 'what is the weather?' }],
      model: 'glm-5.1',
      stream: true,
      tools: [chatTool()],
    });
    const chunks = (await response.text())
      .split('\n\n')
      .map((frame) => frame.replace(/^data: /, '').trim())
      .filter((frame) => frame.length > 0 && frame !== '[DONE]')
      .map((frame) => JSON.parse(frame) as JsonRecord);

    expect(chunks.length > 0).toBe(true);
    chunks.forEach((chunk) => {
      // Every chunk is a chunk, not a completion: a client that switches on
      // `object` would otherwise read the first one as the whole answer.
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(Array.isArray(chunk.choices)).toBe(true);
    });

    const fragments = chunks.flatMap((chunk) => {
      const choice = (chunk.choices as JsonRecord[])[0];
      const delta = choice?.delta as JsonRecord | undefined;

      return ((delta?.tool_calls ?? []) as JsonRecord[]).map((toolCall) => ({
        arguments: String(
          (toolCall.function as JsonRecord | undefined)?.arguments ?? '',
        ),
        id: toolCall.id as string | undefined,
        index: toolCall.index as number | undefined,
        name: (toolCall.function as JsonRecord | undefined)?.name as
          string | undefined,
      }));
    });

    // Every fragment that carries an id carries the same one, so a client
    // keying the call off the id — as the OpenAI SDKs do — accumulates one
    // call rather than one per fragment.
    const ids = new Set(
      fragments
        .map((fragment) => fragment.id)
        .filter((id): id is string => id !== undefined),
    );
    expect([...ids]).toEqual(['call_weather_1']);
    const names = new Set(
      fragments
        .map((fragment) => fragment.name)
        .filter((name): name is string => name !== undefined),
    );
    expect([...names]).toEqual(['get_weather']);
    expect(fragments.every((fragment) => fragment.index === 0)).toBe(true);
    expect(
      JSON.parse(fragments.map((fragment) => fragment.arguments).join('')),
    ).toEqual({ city: 'Shanghai' });

    const last = (chunks.at(-1)?.choices as JsonRecord[])[0];
    expect(last.finish_reason).toBe('tool_calls');
  });
});
