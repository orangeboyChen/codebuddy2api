import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { handleMessagesRequest } from '@/lib/server/anthropic';

const tempConfigDir = path.join(process.cwd(), '.tmp-test-config-anthropic');
const tempCredsDir = path.join(process.cwd(), '.tmp-test-creds-anthropic');

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

const makeSseResponse = (frames: string[]): Response => {
  return new Response(frames.join('\n\n') + '\n\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

describe('anthropic messages api', () => {
  beforeEach(() => {
    cleanupTempState();
    vi.restoreAllMocks();
    process.env.CODEBUDDY_CONFIG_PATH =
      '.tmp-test-config-anthropic/config.json';
    process.env.CODEBUDDY_CREDS_DIR = '.tmp-test-creds-anthropic';
    process.env.CODEBUDDY_PASSWORD = '';
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';
    process.env.CODEBUDDY_ROTATION_COUNT = '1';
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('returns 400 when messages is missing', async () => {
    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {},
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.type).toBe('error');
  });

  it('translates a simple non-streaming request and response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        id: 'chatcmpl_123',
        model: 'claude-sonnet-4.6',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello from the assistant!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: {
            cached_tokens: 3,
            cache_creation_tokens: 2,
          },
        },
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(response.status).toBe(200);

    const json = (await response.json()) as Record<string, unknown>;

    expect(json.type).toBe('message');
    expect(json.role).toBe('assistant');
    expect(json.stop_reason).toBe('end_turn');

    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Hello from the assistant!');

    const usage = json.usage as Record<string, number>;
    // input_tokens excludes cached/created tokens (prompt_tokens=10, cached=3, created=2 → 5)
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(5);
    expect(usage.cache_read_input_tokens).toBe(3);
    expect(usage.cache_creation_input_tokens).toBe(2);

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;

    expect(upstreamBody.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(upstreamBody.max_tokens).toBe(1024);
    expect(upstreamBody.stream).toBe(true);
  });

  it('translates tool_use blocks in non-streaming response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        id: 'chatcmpl_tool',
        model: 'claude-sonnet-4.6',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Shanghai"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'What is the weather?' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;

    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toBe('call_abc');
    expect(content[0].name).toBe('get_weather');
    expect(content[0].input).toEqual({ city: 'Shanghai' });
    expect(json.stop_reason).toBe('tool_use');
  });

  it('translates thinking/reasoning content in non-streaming response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        id: 'chatcmpl_think',
        model: 'claude-sonnet-4.6',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'Let me think about this...',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 10,
          total_tokens: 15,
          completion_tokens_details: {
            reasoning_tokens: 4,
          },
        },
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 5000 },
        messages: [{ role: 'user', content: 'What is the answer?' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;

    expect(content[0].type).toBe('thinking');
    expect(content[0].thinking).toBe('Let me think about this...');
    expect(content[1].type).toBe('text');
    expect(content[1].text).toBe('The answer is 42.');
  });

  it('translates tool_result content blocks in messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        id: 'chatcmpl_followup',
        model: 'claude-sonnet-4.6',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Got it.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Check weather' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 'Shanghai' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: '{"temperature":30}',
              },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
      }>;
    };

    // assistant tool_use → structured tool_calls (not flattened text)
    const assistantMsg = upstreamBody.messages.find(
      (m) => m.role === 'assistant',
    );
    expect(assistantMsg?.tool_calls).toHaveLength(1);
    expect(assistantMsg?.tool_calls?.[0].id).toBe('toolu_1');
    expect(assistantMsg?.tool_calls?.[0].function.name).toBe('get_weather');
    expect(assistantMsg?.tool_calls?.[0].function.arguments).toBe(
      '{"city":"Shanghai"}',
    );

    // tool_result → tool role with tool_call_id matching the previous call
    const toolMsg = upstreamBody.messages.find((m) => m.tool_call_id);
    expect(toolMsg?.content).toBe('{"temperature":30}');
    expect(toolMsg?.tool_call_id).toBe('toolu_1');
  });

  it('translates Anthropic tools to OpenAI function tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            input_schema: {
              type: 'object',
              properties: { q: { type: 'string' } },
            },
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tools: Array<Record<string, unknown>> };

    expect(upstreamBody.tools).toHaveLength(1);
    expect(upstreamBody.tools[0].type).toBe('function');
    expect(upstreamBody.tools[0].function).toEqual({
      name: 'search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
      },
    });
  });

  it('translates tool_choice options', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [
          {
            name: 'search',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'tool', name: 'search' },
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: Record<string, unknown> };

    expect(upstreamBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'search' },
    });
  });

  it('handles streaming with text content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_s","model":"claude-sonnet-4.6","choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"id":"chatcmpl_s","model":"claude-sonnet-4.6","choices":[{"delta":{"content":" world"}}]}',
        'data: {"id":"chatcmpl_s","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Say hello' }],
      },
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('"type":"text"');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"text":"Hello"');
    expect(text).toContain('"text":" world"');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('event: message_stop');
  });

  it('handles streaming with tool_use blocks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_t","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
        'data: {"id":"chatcmpl_t","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Shanghai\\"}"}}]},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [
          {
            name: 'get_weather',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
    );

    const text = await response.text();

    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"id":"call_1"');
    expect(text).toContain('"name":"get_weather"');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('handles streaming with thinking/reasoning content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_th","model":"claude-sonnet-4.6","choices":[{"delta":{"reasoning_content":"Thinking..."}}]}',
        'data: {"id":"chatcmpl_th","model":"claude-sonnet-4.6","choices":[{"delta":{"content":"Answer"}}]}',
        'data: {"id":"chatcmpl_th","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 5000 },
        messages: [{ role: 'user', content: 'Think and answer' }],
      },
    );

    const text = await response.text();

    expect(text).toContain('"type":"thinking"');
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"thinking":"Thinking..."');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"text":"Answer"');
  });

  it('handles upstream error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({ error: 'bad request' }, 400),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(response.status).toBe(400);
  });

  it('handles system as content blocks array', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        system: [
          { type: 'text', text: 'System rule 1.' },
          { type: 'text', text: 'System rule 2.' },
        ],
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    expect(upstreamBody.messages[0].role).toBe('system');
    expect(upstreamBody.messages[0].content).toBe(
      'System rule 1.\nSystem rule 2.',
    );
  });

  it('maps tool_choice auto and none', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: { type: 'auto' },
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };

    expect(upstreamBody.tool_choice).toBe('auto');
  });

  it('handles finish_reason length as max_tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [
          {
            message: { content: 'truncated' },
            finish_reason: 'length',
          },
        ],
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Long response' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    expect(json.stop_reason).toBe('max_tokens');
  });

  it('clamps input_tokens to zero when cache exceeds prompt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
          prompt_tokens_details: {
            cached_tokens: 5,
            cache_creation_tokens: 2,
          },
        },
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const usage = json.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(5);
    expect(usage.cache_creation_input_tokens).toBe(2);
  });

  it('reports cache tokens in streaming usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_cu","model":"claude-sonnet-4.6","choices":[{"delta":{"content":"ok"}}]}',
        'data: {"id":"chatcmpl_cu","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23,"prompt_tokens_details":{"cached_tokens":8,"cache_creation_tokens":4}}}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const text = await response.text();
    // input_tokens = 20 - 8 - 4 = 8, reported in message_delta usage
    expect(text).toContain('"input_tokens":8');
    expect(text).toContain('"cache_read_input_tokens":8');
    expect(text).toContain('"cache_creation_input_tokens":4');
  });

  it('handles unexpected errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('Network failure'),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(response.status).toBe(500);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it('handles multiple tool calls in streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_mt","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"tool_a","arguments":"{}"}}]}}]}',
        'data: {"id":"chatcmpl_mt","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"tool_b","arguments":"{}"}}]}}]}',
        'data: {"id":"chatcmpl_mt","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Use two tools' }],
        tools: [
          { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
          { name: 'tool_b', input_schema: { type: 'object', properties: {} } },
        ],
      },
    );

    const text = await response.text();

    expect(text).toContain('"id":"call_a"');
    expect(text).toContain('"id":"call_b"');
    expect(text).toContain('"name":"tool_a"');
    expect(text).toContain('"name":"tool_b"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('maps tool_choice any to required', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: { type: 'any' },
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };

    expect(upstreamBody.tool_choice).toBe('required');
  });

  it('passes stop_sequences as stop', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stop_sequences: ['END', 'STOP'],
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { stop: unknown };

    expect(upstreamBody.stop).toEqual(['END', 'STOP']);
  });

  it('maps tool_choice none', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: { type: 'none' },
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };

    expect(upstreamBody.tool_choice).toBe('none');
  });

  it('handles invalid JSON in tool call arguments gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: {
                    name: 'bad_tool',
                    arguments: 'not valid json{',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Use a tool' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0].input).toEqual({});
  });

  it('handles tool call without id in non-streaming response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'no_id_tool',
                    arguments: '{}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Use a tool' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('tool_use');
    expect(content[0].id).toMatch(/^toolu_/);
  });

  it('handles reasoning field (not reasoning_content) in non-streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Result.',
              reasoning: 'My reasoning here.',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Answer' }],
      },
    );

    const json = (await response.json()) as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe('thinking');
    expect(content[0].thinking).toBe('My reasoning here.');
  });

  it('handles streaming response with no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('handles content blocks with text objects in messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world' },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    const userMsg = upstreamBody.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('Hello \nworld');
  });

  it('handles content blocks with unknown type', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', content: 'base64data' },
              { type: 'text', text: 'describe this' },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    const userMsg = upstreamBody.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('describe this');
    expect(userMsg?.content).toContain('base64data');
  });

  it('handles thinking blocks in conversation history (skipped)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'previous thoughts' },
              { type: 'text', text: 'previous answer' },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string | null }> };

    const contents = upstreamBody.messages.map((m) => m.content);
    expect(contents).not.toContain('previous thoughts');
    expect(contents).toContain('previous answer');
  });

  it('handles non-Error thrown in handler', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('string error');

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(response.status).toBe(500);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it('handles tool_result with array content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Check' },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'result part 1' },
                  { type: 'text', text: 'result part 2' },
                ],
              },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    const contents = upstreamBody.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes('result part 1result part 2'))).toBe(
      true,
    );
  });

  it('handles streaming with unparseable frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: not valid json',
        'data: {"id":"chatcmpl_ok","model":"claude-sonnet-4.6","choices":[{"delta":{"content":"ok"}}]}',
        'data: {"id":"chatcmpl_ok","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text":"ok"');
    expect(text).toContain('event: message_stop');
  });

  it('handles streaming with tool call without id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_noid","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"anon_tool","arguments":"{}"}}]}}]}',
        'data: {"id":"chatcmpl_noid","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Use tool' }],
      },
    );

    const text = await response.text();
    expect(text).toContain('"name":"anon_tool"');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('handles non-string system content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        system: [{ type: 'custom', content: { nested: true } }],
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    expect(upstreamBody.messages[0].role).toBe('system');
    expect(upstreamBody.messages[0].content).toContain('nested');
  });

  it('handles empty content array in messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: [] },
          { role: 'user', content: 'real message' },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ role: string; content: string }> };

    const userMessages = upstreamBody.messages.filter((m) => m.role === 'user');
    expect(userMessages[userMessages.length - 1].content).toBe('real message');
  });

  it('passes thinking config to upstream body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        thinking: { type: 'enabled', budget_tokens: 10000 },
        messages: [{ role: 'user', content: 'Think' }],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { thinking: Record<string, unknown> };

    expect(upstreamBody.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10000,
    });
  });

  it('handles non-object tool_choice passthrough', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: 'auto',
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { tool_choice: unknown };

    expect(upstreamBody.tool_choice).toBe('auto');
  });

  it('concatenates streamed tool name fragments', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_frag","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_frag","type":"function","function":{"name":"look"}}]}}]}',
        'data: {"id":"chatcmpl_frag","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"{\\"city\\":"}}]}}]}',
        'data: {"id":"chatcmpl_frag","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Shanghai\\"}"}}]}}]}',
        'data: {"id":"chatcmpl_frag","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [
          {
            name: 'lookup',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      },
    );

    const text = await response.text();

    // The full name "lookup" should appear in content_block_start, not
    // a partial fragment like "look".
    expect(text).toContain('"name":"lookup"');
    expect(text).not.toContain('"name":"look"');
    expect(text).toContain('"id":"call_frag"');
    expect(text).toContain('"type":"input_json_delta"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('emits content_block_start for tool with name-only deltas', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_noarg","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_noarg","type":"function","function":{"name":"only_name"}}]}}]}',
        'data: {"id":"chatcmpl_noarg","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Use tool' }],
      },
    );

    const text = await response.text();

    expect(text).toContain('"name":"only_name"');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  it('closes text block before starting tool_use in streaming', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse([
        'data: {"id":"chatcmpl_txt","model":"claude-sonnet-4.6","choices":[{"delta":{"content":"Let me check that."}}]}',
        'data: {"id":"chatcmpl_txt","model":"claude-sonnet-4.6","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_txt","type":"function","function":{"name":"search","arguments":"{}"}}]}}]}',
        'data: {"id":"chatcmpl_txt","model":"claude-sonnet-4.6","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ]),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Search for me' }],
      },
    );

    const text = await response.text();

    // The text block must be stopped before the tool_use block starts.
    const textStopIdx = text.indexOf('content_block_stop');
    const toolStartIdx = text.indexOf('"type":"tool_use"');
    expect(textStopIdx).toBeGreaterThan(-1);
    expect(toolStartIdx).toBeGreaterThan(-1);
    expect(textStopIdx).toBeLessThan(toolStartIdx);

    // Both text and tool_use blocks should have their own stop events.
    const stopCount = (text.match(/event: content_block_stop/g) || []).length;
    expect(stopCount).toBe(2);
  });

  it('preserves assistant tool_use as structured tool_calls in request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Use tools' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_a',
                name: 'search',
                input: { query: 'hello' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_a',
                content: 'found it',
              },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
      }>;
    };

    const assistantMsg = upstreamBody.messages.find(
      (m) => m.role === 'assistant',
    );
    expect(assistantMsg?.tool_calls).toEqual([
      {
        id: 'toolu_a',
        type: 'function',
        function: { name: 'search', arguments: '{"query":"hello"}' },
      },
    ]);
    expect(assistantMsg?.content).toBeNull();

    const toolMsg = upstreamBody.messages.find((m) => m.tool_call_id);
    expect(toolMsg?.content).toBe('found it');
    expect(toolMsg?.tool_call_id).toBe('toolu_a');
  });

  it('emits tool results before text in mixed user messages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { content: 'ok' } }],
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_adj',
                name: 'search',
                input: { query: 'test' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_adj',
                content: 'result data',
              },
              {
                type: 'text',
                text: 'Here is some context.',
              },
            ],
          },
        ],
      },
    );

    const upstreamBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_call_id?: string;
      }>;
    };

    const toolIdx = upstreamBody.messages.findIndex(
      (m) => m.tool_call_id === 'toolu_adj',
    );
    const userIdx = upstreamBody.messages.findIndex(
      (m) => m.role === 'user' && typeof m.content === 'string',
    );

    // Tool result must come before the free-form user text so it stays
    // adjacent to the preceding assistant tool_calls.
    expect(toolIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeLessThan(userIdx);
  });

  it('preserves reasoning_content in non-streaming responses', async () => {
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'cb-key';

    const sseBody = [
      'data: {"id":"chatcmpl_r","object":"chat.completion.chunk","created":1,"model":"claude-sonnet-4.6","choices":[{"delta":{"reasoning_content":"Let me think..."}}]}',
      'data: {"choices":[{"delta":{"content":"The answer is 42."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
      'data: [DONE]',
    ].join('\n\n');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(sseBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      }),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        model: 'claude-sonnet-4.6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'What is the answer?' }],
        thinking: { type: 'enabled', budget_tokens: 1024 },
      },
    );

    const payload = (await response.json()) as {
      content: Array<{ type: string; thinking?: string; text?: string }>;
    };

    const thinkingBlock = payload.content.find((b) => b.type === 'thinking');
    const textBlock = payload.content.find((b) => b.type === 'text');

    expect(thinkingBlock?.thinking).toBe('Let me think...');
    expect(textBlock?.text).toBe('The answer is 42.');
  });
});
