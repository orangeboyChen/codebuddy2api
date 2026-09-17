import { createErrorResponse } from '../../shared/http';
import { createSseResponse } from '../../shared/sse';
import {
  chatStreamErrorChunks,
  createStreamCloser,
  toUpstreamTimeoutMessage,
} from '../../shared/upstream-timeout';
import { recordProxyUsage } from './usage';
import {
  type ChatStreamChunk,
  type ChatStreamDelta,
  CORS_HEADERS,
  MAX_STREAM_FRAME_LENGTH,
  type ProxyContext,
  type ToolCallChunk,
  type ToolCallMapping,
  type ToolCallNormalizationState,
} from './types';

export const aggregateToolCalls = (
  toolCalls: NonNullable<ChatStreamDelta['tool_calls']>,
): Array<{
  id?: string;
  type?: string;
  function: {
    arguments: string;
    name: string;
  };
}> => {
  const aggregated = new Map<
    string,
    {
      order: number;
      id?: string;
      type?: string;
      function: {
        arguments: string;
        name: string;
      };
    }
  >();
  const latestKeyByIndex = new Map<number, string>();

  toolCalls.forEach((toolCall, position) => {
    const normalizedId = createNormalizedToolCallId(toolCall.id, position);
    const key =
      (toolCall.id ? `id:${normalizedId}` : undefined) ??
      (typeof toolCall.index === 'number'
        ? latestKeyByIndex.get(toolCall.index)
        : undefined) ??
      `position:${position}`;
    const current = aggregated.get(key) ?? {
      order: aggregated.size,
      function: {
        arguments: '',
        name: '',
      },
    };

    if (toolCall.id) {
      current.id = normalizedId;
    }

    if (toolCall.type) {
      current.type = toolCall.type;
    }

    if (toolCall.function?.name) {
      current.function.name += toolCall.function.name;
    }

    if (toolCall.function?.arguments) {
      current.function.arguments += toolCall.function.arguments;
    }

    aggregated.set(key, current);

    if (typeof toolCall.index === 'number') {
      latestKeyByIndex.set(toolCall.index, key);
    }
  });

  return [...aggregated.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...value }, index) => ({
      ...value,
      id: value.id ?? createNormalizedToolCallId(undefined, index),
    }));
};

export const getToolCallStateKey = (
  toolCall: ToolCallChunk,
  position: number,
): string => {
  if (toolCall.id) {
    return `id:${toolCall.id}`;
  }

  if (typeof toolCall.index === 'number') {
    return `index:${toolCall.index}`;
  }

  return `position:${position}`;
};

export const createNormalizedToolCallId = (
  sourceId: string | undefined,
  normalizedIndex: number,
): string => {
  if (sourceId && !sourceId.startsWith('tooluse_')) {
    return sourceId;
  }

  const suffix =
    sourceId?.replace(/^tooluse_/, '') ??
    `${normalizedIndex}_${crypto.randomUUID().replaceAll('-', '')}`;

  return `call_${suffix}`;
};

export const resolveToolCallMapping = (
  state: ToolCallNormalizationState,
  toolCall: ToolCallChunk,
  position: number,
): ToolCallMapping => {
  const keys = toolCall.id
    ? [`id:${toolCall.id}`]
    : [
        typeof toolCall.index === 'number' ? `index:${toolCall.index}` : null,
        `position:${position}`,
      ].filter((value): value is string => value !== null);
  const existing = keys
    .map((key) => state.mappings.get(key))
    .find((value) => value !== undefined);

  if (existing) {
    return existing;
  }

  return {
    id: createNormalizedToolCallId(toolCall.id, state.nextIndex),
    index: state.nextIndex++,
  };
};

export const normalizeStreamToolCalls = (
  chunk: ChatStreamChunk,
  state: ToolCallNormalizationState,
): ChatStreamChunk => {
  if (!chunk.choices?.length) {
    return chunk;
  }

  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      if (!choice.delta?.tool_calls?.length) {
        return choice;
      }

      return {
        ...choice,
        delta: {
          ...choice.delta,
          tool_calls: choice.delta.tool_calls.map((toolCall, position) => {
            const mapping = resolveToolCallMapping(state, toolCall, position);
            const sourceKey = getToolCallStateKey(toolCall, position);

            state.mappings.set(sourceKey, mapping);

            if (toolCall.id) {
              state.mappings.set(`id:${toolCall.id}`, mapping);
            }

            if (typeof toolCall.index === 'number') {
              state.mappings.set(`index:${toolCall.index}`, mapping);
            }

            return {
              ...toolCall,
              id: mapping.id,
              index: mapping.index,
            };
          }),
        },
      };
    }),
  };
};

export const normalizeStreamingResponse = ({
  model,
  proxyContext,
  route,
  upstreamResponse,
}: {
  model: string;
  proxyContext: ProxyContext;
  route: string;
  upstreamResponse: Response;
}): Response => {
  if (!upstreamResponse.body) {
    return createSseResponse(null, {
      headers: CORS_HEADERS,
      status: upstreamResponse.status,
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state: ToolCallNormalizationState = {
    mappings: new Map<string, ToolCallMapping>(),
    nextIndex: 0,
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const closer = createStreamCloser();
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let latestUsage: unknown = null;

      const processFrame = (frame: string): string => {
        const lines = frame.split('\n');
        const lineIndex = lines.findIndex((line) => line.startsWith('data: '));

        if (lineIndex === -1) {
          return frame;
        }

        const raw = lines[lineIndex]?.slice(6).trim() ?? '';

        if (!raw || raw === '[DONE]') {
          return frame;
        }

        try {
          const chunk = JSON.parse(raw) as ChatStreamChunk;
          if (chunk.usage !== undefined) {
            latestUsage = chunk.usage;
          }
          const normalized = normalizeStreamToolCalls(chunk, state);
          lines[lineIndex] = `data: ${JSON.stringify(normalized)}`;
          return lines.join('\n');
        } catch {
          return frame;
        }
      };

      const flushFrames = (frames: string[]): void => {
        frames.forEach((frame) => {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            return;
          }
          controller.enqueue(encoder.encode(`${processFrame(frame)}\n\n`));
        });
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            if (buffer.trim()) {
              flushFrames([buffer]);
            }

            await recordProxyUsage({
              model,
              proxyContext,
              route,
              usage: latestUsage,
            });

            releaseReader();
            try {
              controller.close();
            } catch {
              // The downstream stream may have been cancelled while the pump was completing.
            }
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
          flushFrames(frames);
        }
      };

      void pump().catch((error) => {
        if (cancelled) return;
        const timeoutMessage = toUpstreamTimeoutMessage(error);

        if (timeoutMessage !== null) {
          closer.fail(controller, chatStreamErrorChunks(timeoutMessage));
          return;
        }

        controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      closer.mark();
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return createSseResponse(stream, {
    headers: CORS_HEADERS,
    status: upstreamResponse.status,
  });
};

export const aggregateUpstreamStream = async (
  upstreamResponse: Response,
  fallbackModel: string,
): Promise<{ model: string; response: Response; usage: unknown }> => {
  const payloadText = await upstreamResponse.text();
  const toolCalls: NonNullable<ChatStreamDelta['tool_calls']> = [];
  let responseId = '';
  let responseObject = 'chat.completion';
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let content = '';
  let reasoningContent = '';
  let finishReason: string | null = 'stop';
  let role = 'assistant';
  let usage: unknown = null;

  for (const frame of payloadText.split('\n\n')) {
    const line = frame
      .split('\n')
      .find((segment) => segment.startsWith('data: '));

    if (!line) {
      continue;
    }

    const raw = line.slice(6).trim();

    if (!raw || raw === '[DONE]') {
      continue;
    }

    let chunk: ChatStreamChunk;

    try {
      chunk = JSON.parse(raw) as ChatStreamChunk;
    } catch {
      return {
        model: fallbackModel,
        response: createErrorResponse(
          502,
          'Failed to parse upstream SSE frame',
        ),
        usage: null,
      };
    }

    if (chunk.id) {
      responseId = chunk.id;
    }

    if (chunk.object) {
      responseObject = chunk.object.replace(/\.chunk$/, '');
    }

    if (typeof chunk.created === 'number') {
      created = chunk.created;
    }

    if (chunk.model) {
      model = chunk.model;
    }

    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.role) {
      role = delta.role;
    }

    if (delta?.content) {
      content += delta.content;
    }

    if (delta?.reasoning_content ?? delta?.reasoning) {
      reasoningContent += delta.reasoning_content ?? delta.reasoning;
    }

    if (delta?.tool_calls?.length) {
      toolCalls.push(...delta.tool_calls);
    }

    if (choice?.finish_reason !== undefined) {
      finishReason = choice.finish_reason ?? finishReason;
    }
  }

  const aggregatedToolCalls = aggregateToolCalls(toolCalls);
  const message: Record<string, unknown> = {
    role,
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (aggregatedToolCalls.length) {
    message.tool_calls = aggregatedToolCalls;
  }

  return {
    model,
    response: Response.json({
      id: responseId || `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`,
      object: responseObject,
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            finishReason ??
            (aggregatedToolCalls.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage,
    }),
    usage,
  };
};
