import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from '@/lib/server/domain/config';
import { updateSettings } from '@/lib/server/domain/config';
import { createAccessKey } from '@/lib/server/domain/access-keys';
import { resetWebSearchProviders } from '@/lib/server/search';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import {
  clearClosingHop,
  executeImageGeneration,
  executeImageGenerationLoop,
  isImageGenerationToolCall,
} from '@/lib/server/proxy/image-generation';
import type { ProxyContext } from '@/lib/server/proxy/codebuddy';
import {
  attachServerToolExecutions,
  getServerToolExecutions,
} from '@/lib/server/proxy/web-search-loop';
import {
  handleResponsesRequest,
  resetResponseSessions,
} from '@/lib/server/proxy/responses';

const tempRootDir = path.join(process.cwd(), '.tmp-test-image-generation');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, maxRetries: 5, recursive: true });
};

const makeRequest = (secret?: string): NextRequest => {
  return new NextRequest('http://localhost/v1/responses', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    method: 'POST',
  });
};

const makeChatResponse = (message: Record<string, unknown>): Response => {
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: 'stop', message }] }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};

const makeImageResponse = (data: unknown): Response => {
  return new Response(JSON.stringify({ data }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

const requestBodies = (): Array<Record<string, unknown>> => {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')),
    ) as Array<Record<string, unknown>>;
};

const makeContext = (): ProxyContext => {
  return {
    accessKeyId: null,
    accessKeyName: null,
    auth: {
      bearerToken: 'image-gen-token',
      credentialData: {},
      type: 'bearer',
      userId: 'image-gen@example.com',
    },
    credentialFilename: null,
    preferences: {
      firstMessageRoleToSystem: false,
      firstSystemMessageRoleToUser: false,
      upstreamProtocol: 'chat',
    },
  };
};

const addCredentialWith = async (
  overrides: Record<string, unknown> = {},
): Promise<string> => {
  const credential = await addCredential({
    bearer_token: 'image-gen-token',
    user_id: 'image-gen@example.com',
    ...overrides,
  });
  const accessKey = await createAccessKey({
    credentialFilenames: [credential.filename],
    name: 'Image Gen Key',
  });

  return accessKey.secret;
};

describe('Responses image support', () => {
  beforeEach(async () => {
    cleanupTempState();
    resetCredentialRuntimeState();
    resetResponseSessions();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_AUTH_MODE = 'api_key';
    process.env.CODEBUDDY_API_KEY = 'image-gen-key';
  });

  afterEach(() => {
    cleanupTempState();
  });

  describe('input_image on the chat path', () => {
    it('preserves an image part instead of stringifying it', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'a cat' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            content: [
              { text: 'what is this', type: 'input_text' },
              {
                image_url: 'data:image/png;base64,iVBORw0KGgo=',
                type: 'input_image',
              },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const bodies = requestBodies().filter((body) =>
        Array.isArray(body.messages),
      );
      expect(bodies[bodies.length - 1]?.messages).toEqual([
        {
          content: [
            'what is this',
            {
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ]);
    });

    it('keeps a plain text message as a string', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          { content: [{ text: 'hello', type: 'input_text' }], role: 'user' },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const bodies = requestBodies().filter((body) =>
        Array.isArray(body.messages),
      );
      expect(bodies[bodies.length - 1]?.messages).toEqual([
        { content: 'hello', role: 'user' },
      ]);
    });

    it('preserves an image returned by a tool', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            call_id: 'call_1',
            output: [
              { text: 'screenshot taken', type: 'input_text' },
              {
                image_url: 'data:image/png;base64,iVBORw0KGgo=',
                type: 'input_image',
              },
            ],
            type: 'function_call_output',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      // The chat path maps the output to a tool message, then the Responses
      // converter rebuilds it as `function_call_output` with the image intact.
      const toolMessages = requestBodies()
        .flatMap(
          (candidate) =>
            (candidate.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages[0]?.content).toEqual([
        'screenshot taken',
        {
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
          type: 'image_url',
        },
      ]);
    });

    it('accepts an image with an object or bare-URL shape', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            content: [
              { image_url: { url: 'data:image/png;base64,AAAA' } },
              { image_url: 'https://example.com/b.png', type: 'input_image' },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const bodies = requestBodies().filter((body) =>
        Array.isArray(body.messages),
      );
      expect(bodies.at(-1)?.messages).toEqual([
        {
          content: [
            {
              image_url: { url: 'data:image/png;base64,AAAA' },
              type: 'image_url',
            },
            {
              image_url: { url: 'https://example.com/b.png' },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ]);
    });

    it('drops an image part whose url cannot be read', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            content: [
              { image_url: '', type: 'input_image' },
              { text: 'still here', type: 'input_text' },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const bodies = requestBodies().filter((body) =>
        Array.isArray(body.messages),
      );
      // The unusable part is dropped, leaving a single text part.
      expect(bodies.at(-1)?.messages).toEqual([
        { content: ['still here'], role: 'user' },
      ]);
    });

    it('keeps a tool output without images as plain text', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            call_id: 'call_1',
            output: [{ text: 'plain result', type: 'input_text' }],
            type: 'function_call_output',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const toolMessages = requestBodies()
        .flatMap(
          (body) => (body.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages[0]?.content).toBe('plain result');
    });
  });

  describe('image_generation tool', () => {
    it('executes a generation and replays the result to the model', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }

        chatCall += 1;

        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here is your cat.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };

      // The generated image is returned as a standard image_generation_call
      // output item, ahead of the assistant's text.
      expect(payload.output[0]).toMatchObject({
        result: 'QUJD',
        revised_prompt: 'a cat',
        status: 'completed',
        type: 'image_generation_call',
      });

      const message = payload.output[1] as {
        content: Array<{ text: string }>;
      };
      expect(message.content[0]?.text).toBe('Here is your cat.');

      const imageRequest = requestBodies().find((body) => 'prompt' in body);
      expect(imageRequest).toEqual({
        prompt: 'a cat',
        response_format: 'b64_json',
      });

      const toolMessages = requestBodies()
        .flatMap(
          (body) => (body.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages).toEqual([
        {
          content: 'data:image/png;base64,QUJD',
          role: 'tool',
          tool_call_id: 'call_1',
        },
      ]);
    });

    it('emits a failed image_generation_call when generation fails', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return new Response('upstream exploded', { status: 500 });
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Sorry, that failed.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      // The item is still emitted so the client can tell an image was
      // attempted, but carries no result.
      expect(payload.output[0]).toMatchObject({
        result: null,
        status: 'failed',
        type: 'image_generation_call',
      });
    });

    it('omits revised_prompt when the model sent no prompt', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: { arguments: '{}', name: 'image_generation' },
                    id: 'c1',
                  },
                ],
              }
            : { content: 'done' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      expect(payload.output[0]).toMatchObject({
        result: null,
        status: 'failed',
        type: 'image_generation_call',
      });
      expect(payload.output[0]).not.toHaveProperty('revised_prompt');
    });

    it('executes image calls when a server search tool is also enabled', async () => {
      // Regression: the streaming image path used to sit inside the
      // "no server search tools" branch, so a turn declaring both silently
      // skipped generation and forwarded the call as an ordinary
      // function_call for the client to resolve.
      const spy = vi.spyOn(config, 'isWebSearchEnabled');
      spy.mockResolvedValue(true);

      const secret = await addCredentialWith();
      let chatCall = 0;
      let imageCalls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          imageCalls += 1;
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'done' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'search then draw',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }, { type: 'web_search_preview' }],
      } as never);

      expect(imageCalls).toBe(1);
      const text = await response.text();
      expect(text).toContain('image_generation_call');
      expect(text).not.toContain('"type":"function_call"');

      spy.mockRestore();
    });

    it('streams the image_generation_call as Responses SSE events', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here is your cat.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const text = await response.text();

      // The client sees the standard item, not a function_call it must resolve.
      expect(text).toContain('"type":"image_generation_call"');
      expect(text).toContain('"result":"QUJD"');
      expect(text).not.toContain('"type":"function_call"');
      expect(text).toContain('event: response.output_item.added');
      expect(text).toContain('event: response.completed');
    });

    it('replays buffered text as delta events', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here is your cat.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      const text = await response.text();

      // A client that renders as it reads subscribes to deltas, so arriving
      // whole in response.completed would show nothing until the turn ends.
      expect(text).toContain('event: response.output_text.delta');
      expect(text).toContain('"delta":"Here is your cat."');
      expect(text).toContain('event: response.output_text.done');
    });

    it('replays deltas even when the model never calls the tool', async () => {
      // Regression: buffering happens because the tool was declared, so a
      // turn that never used it still lost its streamed text.
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'A long answer about cats.' }),
      );

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'tell me about cats',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      const text = await response.text();
      expect(text).toContain('"delta":"A long answer about cats."');
    });

    it('marks a URL-only result completed without inline data', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ url: 'https://example.com/a.png' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here it is.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      // The upstream returned a hosted URL rather than inline bytes, so there
      // is no base64 to hand back, but the call itself succeeded.
      expect(payload.output[0]).toMatchObject({
        result: null,
        status: 'completed',
        type: 'image_generation_call',
      });
    });

    it('returns a failed upstream response from a streaming image call', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Promise.resolve(new Response('upstream down', { status: 502 })),
      );

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(502);
    });

    it('keeps prose the model wrote before calling the tool', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                // A model commonly explains itself before calling a tool.
                content: 'Sure, let me draw that for you.',
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here is your cat.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const payload = (await response.json()) as {
        output_text: string;
        output: Array<Record<string, unknown>>;
      };

      // The loop replays the request with the image appended, so only the final
      // hop's message would survive without folding the earlier prose in.
      expect(payload.output_text).toBe(
        'Sure, let me draw that for you.\n\nHere is your cat.',
      );
      expect(payload.output[0]).toMatchObject({
        result: 'QUJD',
        status: 'completed',
        type: 'image_generation_call',
      });
    });

    it('returns a failed upstream response from a non-streaming image call', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Promise.resolve(new Response('upstream down', { status: 502 })),
      );

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(502);
    });

    it('reports a failure as a tool result so the turn continues', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return new Response('upstream exploded', { status: 500 });
        }

        chatCall += 1;

        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Sorry, that failed.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw me a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
      const toolMessages = requestBodies()
        .flatMap(
          (body) => (body.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages[0]?.content).toContain('Image generation failed');
    });

    it('makes no extra upstream call when the model does not ask for an image', async () => {
      const secret = await addCredentialWith();
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(makeChatResponse({ content: 'Sure.' }));

      await handleResponsesRequest(makeRequest(secret), {
        input: 'hello',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const imageCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v2/images/generations'),
      );
      expect(imageCalls).toHaveLength(0);
    });

    it('passes a streamed response through untouched', async () => {
      const secret = await addCredentialWith();
      // A fresh Response per call: the loop issues more than one upstream
      // request, and a reused body cannot be read twice.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Promise.resolve(
          new Response(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
    });

    it('forwards the native declaration on the responses passthrough', async () => {
      const secret = await addCredentialWith({
        upstream_protocol: 'responses',
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'resp_1', output: [], output_text: 'ok' }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation', model: 'gpt-image-2' }],
      } as never);

      const body = requestBodies()[0];
      expect(body).toBeDefined();
      expect(body?.tools).toEqual([
        { model: 'gpt-image-2', type: 'image_generation' },
      ]);
    });

    it('handles string, unusable and empty parts alongside an image', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            content: [
              'leading text',
              42,
              { image_url: 'data:image/png;base64,AAAA', type: 'input_image' },
              { text: 'trailing text', type: 'input_text' },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const bodies = requestBodies().filter((body) =>
        Array.isArray(body.messages),
      );
      expect(bodies.at(-1)?.messages).toEqual([
        {
          content: [
            'leading text',
            {
              image_url: { url: 'data:image/png;base64,AAAA' },
              type: 'image_url',
            },
            'trailing text',
          ],
          role: 'user',
        },
      ]);
    });

    it('preserves a tool-returned image on the responses passthrough', async () => {
      const secret = await addCredentialWith({
        upstream_protocol: 'responses',
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'resp_1', output: [], output_text: 'ok' }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            call_id: 'call_1',
            output: [
              { text: 'screenshot', type: 'input_text' },
              {
                image_url: 'data:image/png;base64,iVBORw0KGgo=',
                type: 'input_image',
              },
            ],
            type: 'function_call_output',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      expect(requestBodies()[0]?.input).toEqual([
        {
          call_id: 'call_1',
          output: [
            { text: 'screenshot', type: 'input_text' },
            {
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              type: 'input_image',
            },
          ],
          type: 'function_call_output',
        },
      ]);
    });

    it('preserves input_image on the responses passthrough', async () => {
      const secret = await addCredentialWith({
        upstream_protocol: 'responses',
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'resp_1', output: [], output_text: 'ok' }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            content: [
              {
                image_url: 'data:image/png;base64,iVBORw0KGgo=',
                type: 'input_image',
              },
            ],
            role: 'user',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      expect(requestBodies()[0]?.input).toEqual([
        {
          content: [
            {
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              type: 'input_image',
            },
          ],
          role: 'user',
        },
      ]);
    });
  });

  describe('executeImageGeneration', () => {
    it('returns null without a prompt', async () => {
      const result = await executeImageGeneration({
        arguments: '{}',
        context: makeContext(),
        request: makeRequest(),
      });

      expect(result).toBeNull();
    });

    it('prefers base64 over a url and tolerates malformed arguments', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          makeImageResponse([
            { b64_json: 'QUJD', url: 'https://example.com/a.png' },
          ]),
        );

      const result = await executeImageGeneration({
        arguments: 'not json at all',
        context: makeContext(),
        request: makeRequest(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('returns a hosted url when no inline data is present', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          makeImageResponse([{ url: 'https://example.com/a.png' }]),
        );

      const result = await executeImageGeneration({
        arguments: '{"prompt":"a cat","size":"512x512","quality":"high"}',
        context: makeContext(),
        request: makeRequest(),
      });

      expect(result).toEqual({ url: 'https://example.com/a.png' });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({
        prompt: 'a cat',
        quality: 'high',
        size: '512x512',
      });
    });

    it('returns null for a malformed or empty upstream payload', async () => {
      for (const data of [undefined, [], [null], [{}], [{}]]) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          makeImageResponse(data),
        );

        const result = await executeImageGeneration({
          arguments: '{"prompt":"a cat"}',
          context: makeContext(),
          request: makeRequest(),
        });

        expect(result).toBeNull();
      }
    });

    it('forwards model, size and quality when supplied', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(makeImageResponse([{ b64_json: 'QUJD' }]));

      const result = await executeImageGeneration({
        arguments:
          '{"prompt":"a cat","model":"gpt-image-2","size":"1024x1024","quality":"high"}',
        context: makeContext(),
        request: makeRequest(),
      });

      expect(result).toEqual({ b64Json: 'QUJD' });
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
      ).toMatchObject({
        model: 'gpt-image-2',
        quality: 'high',
        size: '1024x1024',
      });
    });

    it('ignores blank optional fields and returns null on a network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeImageResponse([{ b64_json: 'QUJD' }]),
      );
      await executeImageGeneration({
        arguments: '{"prompt":"a cat","size":"  ","quality":"","model":"  "}',
        context: makeContext(),
        request: makeRequest(),
      });
      const body = JSON.parse(
        String(
          vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1]?.body as string,
        ),
      );
      expect(body).toEqual({ prompt: 'a cat', response_format: 'b64_json' });

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
      await expect(
        executeImageGeneration({
          arguments: '{"prompt":"a cat"}',
          context: makeContext(),
          request: makeRequest(),
        }),
      ).resolves.toBeNull();
    });
  });

  describe('streaming image generation', () => {
    it('passes an SSE response through without resuming it', async () => {
      const secret = await addCredentialWith();
      // A fresh Response per call: a reused body cannot be read twice.
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        Promise.resolve(
          new Response(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        ),
      );

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
    });
  });

  describe('edge cases', () => {
    it('handles a tool output that is not an array', async () => {
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeChatResponse({ content: 'ok' }),
      );

      await handleResponsesRequest(makeRequest(secret), {
        input: [
          {
            call_id: 'call_1',
            output: 'plain string result',
            type: 'function_call_output',
          },
        ],
        model: 'claude-sonnet-4.6',
      } as never);

      const toolMessages = requestBodies()
        .flatMap(
          (body) => (body.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages[0]?.content).toBe('plain string result');
    });

    it('tolerates a tool call missing its id and arguments', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [{ function: { name: 'image_generation' } }],
              }
            : { content: 'done' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      expect(response.status).toBe(200);
      // The missing id/arguments fall back to empty values rather than
      // aborting the turn.
      const toolMessages = requestBodies()
        .flatMap(
          (body) => (body.messages ?? []) as Array<Record<string, unknown>>,
        )
        .filter((message) => message.role === 'tool');
      expect(toolMessages[0]?.tool_call_id).toBe('');
    });
  });

  describe('rebuilt response shape', () => {
    /**
     * The loop rebuilds every response it hands back, and server-tool
     * executions are keyed on `Response` identity — so reading them off the
     * rebuilt response finds nothing and a search that ran is reported as no
     * search at all. They have to travel with the loop result instead.
     */
    it('carries server-tool executions past the rebuild', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeImageResponse([{ b64_json: 'QUJD' }]),
      );

      const executions = [
        {
          id: 'ws_1',
          input: { query: 'cats' },
          result: { content: 'Cats are small carnivores.', results: [] },
          type: 'web_search' as const,
        },
      ];

      const { response, serverToolExecutions } =
        await executeImageGenerationLoop({
          body: { messages: [{ content: 'hi', role: 'user' }], model: 'm' },
          callUpstream: () =>
            Promise.resolve(
              attachServerToolExecutions(
                makeChatResponse({ content: 'the answer' }),
                executions,
              ),
            ),
          context: makeContext(),
          request: makeRequest(),
        });

      expect(serverToolExecutions).toHaveLength(1);
      // Regression: the executions used to be read off the rebuilt response,
      // which always reported none.
      expect(getServerToolExecutions(response)).toHaveLength(0);
    });

    it('drops framing headers the rebuilt body no longer matches', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeImageResponse([{ b64_json: 'QUJD' }]),
      );

      let chatCall = 0;
      const { response } = await executeImageGenerationLoop({
        body: { messages: [{ content: 'hi', role: 'user' }], model: 'm' },
        callUpstream: () => {
          chatCall += 1;
          const body = JSON.stringify({
            choices: [
              {
                message:
                  chatCall === 1
                    ? {
                        content: 'Let me draw that for you right now.',
                        tool_calls: [
                          {
                            function: {
                              arguments: '{"prompt":"a cat"}',
                              name: 'image_generation',
                            },
                            id: 'call_1',
                            type: 'function',
                          },
                        ],
                      }
                    : { content: 'Here it is.' },
              },
            ],
          });

          return Promise.resolve(
            new Response(body, {
              headers: {
                'Content-Encoding': 'gzip',
                'Content-Length': String(Buffer.byteLength(body)),
                'Content-Type': 'application/json',
              },
              status: 200,
            }),
          );
        },
        context: makeContext(),
        request: makeRequest(),
      });

      // The folded prose makes the body longer than the upstream declared, so
      // a copied content-length would truncate it, and the body is plaintext
      // regardless of how the upstream encoded its own.
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('content-encoding')).toBeNull();
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeGreaterThan(0);
    });

    it('ends the turn without a dangling call when the cap is reached', async () => {
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        // Every hop asks for another image, so the loop exits on the cap.
        return makeChatResponse({
          content: `prose ${chatCall}`,
          tool_calls: [
            {
              function: {
                arguments: '{"prompt":"a cat"}',
                name: 'image_generation',
              },
              id: `call_${chatCall}`,
              type: 'function',
            },
          ],
        });
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat',
        model: 'claude-sonnet-4.6',
        tools: [{ type: 'image_generation' }],
      } as never);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      const types = payload.output.map((item) => item.type);

      // The closing hop's call was executed, so reporting it as a pending
      // function_call would ask the client to resolve work already done.
      expect(types).not.toContain('function_call');
      expect(
        types.filter((type) => type === 'image_generation_call'),
      ).toHaveLength(3);

      const message = payload.output.find(
        (item) => item.type === 'message',
      ) as {
        content: Array<{ text: string }>;
      };
      // Each hop's prose once — the closing hop used to be appended twice.
      expect(message.content[0].text).toBe('prose 1\n\nprose 2\n\nprose 3');
    });

    it('keeps a client-owned call on the capped hop', async () => {
      // A hop can carry calls this loop never runs. The image calls were
      // executed, but a client-declared function is still the client's to
      // resolve — clearing the hop wholesale would silently drop it.
      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        chatCall += 1;
        return makeChatResponse({
          content: `prose ${chatCall}`,
          tool_calls: [
            {
              function: {
                arguments: '{"prompt":"a cat"}',
                name: 'image_generation',
              },
              id: `img_${chatCall}`,
              type: 'function',
            },
            {
              function: {
                arguments: '{"city":"Berlin"}',
                name: 'get_weather',
              },
              id: `client_${chatCall}`,
              type: 'function',
            },
          ],
        });
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat and check the weather',
        model: 'claude-sonnet-4.6',
        tools: [
          { type: 'image_generation' },
          {
            name: 'get_weather',
            parameters: { type: 'object', properties: {} },
            type: 'function',
          },
        ],
      } as never);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      const functionCalls = payload.output.filter(
        (item) => item.type === 'function_call',
      );

      // Only the client's function survives; the executed image call does not.
      expect(functionCalls).toHaveLength(1);
      expect(functionCalls[0]?.name).toBe('get_weather');
      expect(
        payload.output.filter((item) => item.type === 'image_generation_call'),
      ).toHaveLength(3);
    });

    it('emits the web-search lifecycle on a buffered stream', async () => {
      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });

      const secret = await addCredentialWith();
      let chatCall = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }

        // The search backend has to actually answer for an execution to be
        // recorded, or there is no web_search_call item to replay.
        if (url.includes('/agenttool/v1/search')) {
          return makeImageResponse({
            results: [
              {
                content: 'Current result',
                title: 'News',
                url: 'https://news.test',
              },
            ],
          });
        }

        chatCall += 1;

        // The first hop asks the model for a search, which the chat pipeline
        // executes locally before the image loop ever sees the response.
        return makeChatResponse(
          chatCall === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"cats"}',
                      name: 'web_search',
                    },
                    id: 'search_1',
                    type: 'function',
                  },
                  {
                    function: {
                      arguments: '{"prompt":"a cat"}',
                      name: 'image_generation',
                    },
                    id: 'call_1',
                    type: 'function',
                  },
                ],
              }
            : { content: 'Here it is.' },
        );
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'search then draw',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [{ type: 'image_generation' }, { type: 'web_search_preview' }],
      } as never);

      const text = await response.text();

      // A consumer watching for the search lifecycle never sees it if the
      // replay only emits the generic added/done pair.
      expect(text).toContain('event: response.web_search_call.in_progress');
      expect(text).toContain('event: response.web_search_call.searching');
      expect(text).toContain('event: response.web_search_call.completed');
    });

    it('replays a buffered stream whose turn produced no message', async () => {
      // No prose anywhere and a surviving client call on the capped hop means
      // the mapper emits no message item, so the replay has nothing to
      // announce and no deltas to send.
      const secret = await addCredentialWith();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).includes('/v2/images/generations')) {
          return makeImageResponse([{ b64_json: 'QUJD' }]);
        }
        return makeChatResponse({
          content: '',
          tool_calls: [
            {
              function: {
                arguments: '{"prompt":"a cat"}',
                name: 'image_generation',
              },
              id: 'img_1',
              type: 'function',
            },
            {
              function: {
                arguments: '{"city":"Berlin"}',
                name: 'get_weather',
              },
              id: 'client_1',
              type: 'function',
            },
          ],
        });
      });

      const response = await handleResponsesRequest(makeRequest(secret), {
        input: 'draw a cat and check the weather',
        model: 'claude-sonnet-4.6',
        stream: true,
        tools: [
          { type: 'image_generation' },
          {
            name: 'get_weather',
            parameters: { type: 'object', properties: {} },
            type: 'function',
          },
        ],
      } as never);

      const text = await response.text();
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('data: [DONE]');
      expect(text).not.toContain('response.output_text.delta');
    });
  });

  describe('clearClosingHop', () => {
    const imageCall = {
      function: { arguments: '{"prompt":"a cat"}', name: 'image_generation' },
      id: 'img_1',
      type: 'function',
    };
    const clientCall = {
      function: { arguments: '{"city":"Berlin"}', name: 'get_weather' },
      id: 'client_1',
      type: 'function',
    };

    it('keeps calls the loop never ran', () => {
      const payload = {
        choices: [
          {
            message: { content: 'prose', tool_calls: [imageCall, clientCall] },
          },
        ],
      };
      const cleared = clearClosingHop(payload) as {
        choices: Array<{
          message: { content: unknown; tool_calls: unknown[] };
        }>;
      };

      expect(cleared.choices[0].message.tool_calls).toEqual([clientCall]);
      expect(cleared.choices[0].message.content).toBeNull();
    });

    it('returns the payload untouched when it has no choice', () => {
      const payload = { choices: [] };
      expect(clearClosingHop(payload)).toBe(payload);
    });

    it('returns a payload with no choices array untouched', () => {
      // Nothing to clear, so the payload comes back as-is rather than gaining
      // an empty `choices` it never had.
      const payload = {};
      expect(clearClosingHop(payload)).toBe(payload);
    });

    it('tolerates a choice with no message', () => {
      const cleared = clearClosingHop({
        choices: [{ finish_reason: 'stop' }],
      }) as {
        choices: Array<{ message: { tool_calls: unknown[] } }>;
      };
      expect(cleared.choices[0].message.tool_calls).toEqual([]);
    });

    it('tolerates a choice whose message has no calls', () => {
      const payload = { choices: [{ message: { content: 'prose' } }] };
      const cleared = clearClosingHop(payload) as {
        choices: Array<{ message: { tool_calls: unknown[] } }>;
      };
      expect(cleared.choices[0].message.tool_calls).toEqual([]);
    });
  });

  describe('isImageGenerationToolCall', () => {
    it('matches the rewritten function name loosely', () => {
      expect(
        isImageGenerationToolCall({
          function: { name: 'image_generation' },
        }),
      ).toBe(true);
      expect(
        isImageGenerationToolCall({ function: { name: 'image-generation' } }),
      ).toBe(true);
      expect(
        isImageGenerationToolCall({ function: { name: 'web_search' } }),
      ).toBe(false);
      expect(isImageGenerationToolCall(null)).toBe(false);
    });
  });
});
