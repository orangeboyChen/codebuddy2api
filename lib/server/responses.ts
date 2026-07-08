import type { NextRequest } from 'next/server';

import { getAvailableModels } from './config';
import { createErrorResponse } from './http';
import { proxyChatCompletions } from './codebuddy';

type ResponsesInputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  arguments?: string;
  output?: unknown;
  name?: string;
  call_id?: string;
};

type ResponsesRequestBody = {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  tools?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
  max_output_tokens?: number;
  previous_response_id?: string;
};

type ResponseSession = {
  id: string;
  model: string;
  transcript: Array<{ role: string; content: string }>;
  defaults: Pick<ResponsesRequestBody, 'instructions' | 'metadata' | 'tools'>;
};

const globalResponsesState = globalThis as typeof globalThis & {
  __codebuddy2apiResponseSessions__?: Map<string, ResponseSession>;
};

const getSessionStore = (): Map<string, ResponseSession> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessions__) {
    globalResponsesState.__codebuddy2apiResponseSessions__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessions__;
};

const validateTools = (
  tools: ResponsesRequestBody['tools'],
): Response | null => {
  if (!tools?.length) {
    return null;
  }

  const unsupported = tools.find(
    (tool) => tool.type !== 'function' && tool.type !== 'mcp',
  );

  if (!unsupported) {
    return null;
  }

  return createErrorResponse(
    400,
    'Unsupported Responses tool type. Supported types: function, mcp',
  );
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }

        return JSON.stringify(item);
      })
      .join('');
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
};

const mapInputItemToMessage = (
  item: ResponsesInputItem,
): { role: string; content: string } => {
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: `${item.name ?? 'function'}(${item.arguments ?? ''})`,
    };
  }

  if (item.type === 'function_call_output' || item.type === 'mcp_call_output') {
    return {
      role: 'user',
      content: stringifyContent(item.output),
    };
  }

  if (item.type === 'mcp_approval_response') {
    return {
      role: 'user',
      content: JSON.stringify(item),
    };
  }

  return {
    role: item.role ?? 'user',
    content: item.text ?? stringifyContent(item.content),
  };
};

const createResponseId = (): string => {
  return `resp_${crypto.randomUUID().replaceAll('-', '')}`;
};

const prepareTranscript = (
  body: ResponsesRequestBody,
): {
  model: string;
  transcript: Array<{ role: string; content: string }>;
  instructions?: string;
  previousResponseId: string | null;
} => {
  const previousResponseId = body.previous_response_id ?? null;
  const previousSession = previousResponseId
    ? getSessionStore().get(previousResponseId)
    : undefined;

  if (previousResponseId && !previousSession) {
    throw new Error('Unknown or expired previous_response_id');
  }

  const transcript = [...(previousSession?.transcript ?? [])];
  const model =
    body.model ??
    previousSession?.model ??
    getAvailableModels()[0] ??
    'glm-5.1';
  const instructions =
    body.instructions ?? previousSession?.defaults.instructions ?? undefined;

  if (body.messages?.length) {
    body.messages.forEach((item) => {
      transcript.push({
        role: item.role ?? 'user',
        content: stringifyContent(item.content),
      });
    });
  } else if (typeof body.input === 'string') {
    transcript.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item) => {
      transcript.push(mapInputItemToMessage(item));
    });
  }

  return {
    model,
    transcript,
    instructions,
    previousResponseId,
  };
};

const mapChatResponseToResponsesPayload = (
  body: ResponsesRequestBody,
  transcript: Array<{ role: string; content: string }>,
  model: string,
  previousResponseId: string | null,
  upstreamPayload: Record<string, unknown>,
): Record<string, unknown> => {
  const responseId = createResponseId();
  const choices = Array.isArray(upstreamPayload.choices)
    ? upstreamPayload.choices
    : [];
  const firstChoice = (choices[0] ?? {}) as {
    message?: { content?: unknown };
  };
  const outputText = stringifyContent(firstChoice.message?.content);
  const createdAt = Math.floor(Date.now() / 1000);

  getSessionStore().set(responseId, {
    id: responseId,
    model,
    transcript: [...transcript, { role: 'assistant', content: outputText }],
    defaults: {
      instructions: body.instructions,
      metadata: body.metadata,
      tools: body.tools,
    },
  });

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output: [
      {
        id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    usage: upstreamPayload.usage ?? null,
    metadata: body.metadata ?? {},
    previous_response_id: previousResponseId,
  };
};

const createResponsesEventStream = async (
  request: NextRequest,
  body: ResponsesRequestBody,
  transcript: Array<{ role: string; content: string }>,
  model: string,
  previousResponseId: string | null,
): Promise<Response> => {
  const upstreamResponse = await proxyChatCompletions(request, {
    model,
    messages: [
      ...(body.instructions
        ? [{ role: 'system', content: body.instructions }]
        : []),
      ...transcript,
    ],
    max_tokens: body.max_output_tokens,
    stream: true,
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const responseId = createResponseId();
  let outputText = '';

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = upstreamResponse.body!.getReader();
      let buffer = '';

      const enqueueEvent = (payload: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      enqueueEvent({
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
        },
      });
      enqueueEvent({
        type: 'response.in_progress',
        response: {
          id: responseId,
          status: 'in_progress',
        },
      });

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          getSessionStore().set(responseId, {
            id: responseId,
            model,
            transcript: [
              ...transcript,
              { role: 'assistant', content: outputText },
            ],
            defaults: {
              instructions: body.instructions,
              metadata: body.metadata,
              tools: body.tools,
            },
          });
          enqueueEvent({
            type: 'response.completed',
            response: {
              id: responseId,
              status: 'completed',
              output_text: outputText,
              previous_response_id: previousResponseId,
            },
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        frames.forEach((frame) => {
          const line = frame
            .split('\n')
            .find((segment) => segment.startsWith('data: '));

          if (!line) {
            return;
          }

          const raw = line.slice(6).trim();

          if (!raw || raw === '[DONE]') {
            return;
          }

          try {
            const payload = JSON.parse(raw) as {
              choices?: Array<{
                delta?: { content?: string; reasoning_content?: string };
              }>;
            };
            const delta = payload.choices?.[0]?.delta;

            if (delta?.content) {
              outputText += delta.content;
              enqueueEvent({
                type: 'response.output_text.delta',
                delta: delta.content,
                response_id: responseId,
              });
            }

            if (delta?.reasoning_content) {
              enqueueEvent({
                type: 'response.reasoning_text.delta',
                delta: delta.reasoning_content,
                response_id: responseId,
              });
            }
          } catch {
            enqueueEvent({
              type: 'response.error',
              error: {
                message: 'Failed to parse upstream SSE frame',
              },
            });
          }
        });

        await pump();
      };

      void pump();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

export const handleResponsesRequest = async (
  request: NextRequest,
  body: ResponsesRequestBody,
): Promise<Response> => {
  const toolError = validateTools(body.tools);

  if (toolError) {
    return toolError;
  }

  try {
    const prepared = prepareTranscript(body);

    if (body.stream) {
      return await createResponsesEventStream(
        request,
        body,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
      );
    }

    const upstreamResponse = await proxyChatCompletions(request, {
      model: prepared.model,
      messages: [
        ...(prepared.instructions
          ? [{ role: 'system', content: prepared.instructions }]
          : []),
        ...prepared.transcript,
      ],
      max_tokens: body.max_output_tokens,
      stream: false,
    });

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const upstreamPayload = (await upstreamResponse.json()) as Record<
      string,
      unknown
    >;

    return Response.json(
      mapChatResponseToResponsesPayload(
        body,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        upstreamPayload,
      ),
    );
  } catch (error) {
    return createErrorResponse(
      error instanceof Error && error.message.includes('previous_response_id')
        ? 400
        : 500,
      error instanceof Error ? error.message : 'Unexpected responses error',
    );
  }
};

export const resetResponseSessions = (): void => {
  getSessionStore().clear();
};
