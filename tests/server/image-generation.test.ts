import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAccessKey } from '@/lib/server/domain/access-keys';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import {
  executeImageGeneration,
  isImageGenerationToolCall,
} from '@/lib/server/proxy/image-generation';
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
        output: Array<{ content: Array<{ text: string }> }>;
      };
      expect(payload.output[0]?.content[0]?.text).toBe('Here is your cat.');

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
        context: {} as never,
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
        context: {} as never,
        request: makeRequest(),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
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
