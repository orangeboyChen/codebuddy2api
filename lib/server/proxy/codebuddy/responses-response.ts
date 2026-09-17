import { createSseResponse, encodeDoneFrame } from '../../shared/sse';
import {
  chatStreamErrorChunks,
  createStreamCloser,
  readTimeoutFrame,
  toUpstreamTimeoutMessage,
} from '../../shared/upstream-timeout';
import {
  extractResponsesUsage,
  mapResponsesUsageToChat,
  parseUsageHeader,
  recordProxyUsage,
} from './usage';
import {
  CORS_HEADERS,
  MAX_STREAM_FRAME_LENGTH,
  type ProxyContext,
} from './types';

export const normalizeStopSequences = (
  stop: string | string[] | undefined,
): string[] => {
  return (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(Boolean);
};

export const findFirstStopSequence = (
  text: string,
  stopSequences: string[],
): number | null => {
  return stopSequences.reduce<number | null>((earliest, stopSequence) => {
    const index = text.indexOf(stopSequence);
    if (index < 0) return earliest;
    return earliest === null ? index : Math.min(earliest, index);
  }, null);
};

export const getPendingStopPrefixLength = (
  text: string,
  stopSequences: string[],
): number => {
  const maximumLength = Math.min(
    text.length,
    Math.max(
      0,
      ...stopSequences.map((stopSequence) => stopSequence.length - 1),
    ),
  );

  for (let length = maximumLength; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (stopSequences.some((stopSequence) => stopSequence.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
};

export const extractResponsesReasoningText = (output: unknown[]): string => {
  return output
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as {
        content?: unknown;
        summary?: unknown;
        type?: unknown;
      };
      if (value.type !== 'reasoning') return [];
      return [value.summary, value.content].flatMap((parts) => {
        if (!Array.isArray(parts)) return [];
        return parts.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? [text] : [];
        });
      });
    })
    .join('');
};

export const mapResponsesPayloadToChat = (
  payload: Record<string, unknown>,
  model: string,
  stop: string | string[] | undefined,
): Record<string, unknown> => {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const toolCalls = output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (
      value.type !== 'function_call' &&
      value.type !== 'mcp_call' &&
      value.type !== 'custom_tool_call'
    ) {
      return [];
    }
    const isCustomToolCall = value.type === 'custom_tool_call';
    const customArguments = JSON.stringify({
      input: String(value.input ?? value.arguments ?? ''),
    });
    return [
      {
        function: {
          arguments: String(
            isCustomToolCall ? customArguments : (value.arguments ?? ''),
          ),
          name: String(value.name ?? 'function'),
        },
        id: String(value.call_id ?? value.id ?? crypto.randomUUID()),
        type: 'function',
      },
    ];
  });
  const usage =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);

  const rawOutputText =
    typeof payload.output_text === 'string'
      ? payload.output_text
      : output
          .flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const content = (item as { content?: unknown }).content;
            if (!Array.isArray(content)) return [];
            return content.flatMap((part) => {
              if (!part || typeof part !== 'object') return [];
              const value = part as { text?: unknown; type?: unknown };
              return value.type === 'output_text' &&
                typeof value.text === 'string'
                ? [value.text]
                : [];
            });
          })
          .join('');
  const stopIndex = findFirstStopSequence(
    rawOutputText,
    normalizeStopSequences(stop),
  );
  const outputText =
    stopIndex === null ? rawOutputText : rawOutputText.slice(0, stopIndex);
  const reasoningText = extractResponsesReasoningText(output);
  const incompleteReason =
    payload.incomplete_details && typeof payload.incomplete_details === 'object'
      ? (payload.incomplete_details as { reason?: unknown }).reason
      : undefined;
  const finishReason =
    payload.status === 'incomplete'
      ? incompleteReason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : toolCalls.length
        ? 'tool_calls'
        : 'stop';

  return {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        message: {
          content: outputText || null,
          role: 'assistant',
          ...(reasoningText ? { reasoning_content: reasoningText } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    created: Number(payload.created_at ?? Math.floor(Date.now() / 1000)),
    id: String(payload.id ?? `chatcmpl-${crypto.randomUUID()}`),
    model,
    object: 'chat.completion',
    usage: {
      completion_tokens: outputTokens,
      prompt_tokens: inputTokens,
      total_tokens: Number(usage?.total_tokens ?? inputTokens + outputTokens),
    },
  };
};

export const mapResponsesStreamToChat = (
  upstreamResponse: Response,
  model: string,
  proxyContext: ProxyContext,
  route: string,
  stop: string | string[] | undefined,
  includeUsage: boolean,
): Response => {
  const closer = createStreamCloser();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null =
    upstreamResponse.body?.getReader() ?? null;
  const fallbackUsage = parseUsageHeader(upstreamResponse);
  let buffer = '';
  let emittedFinish = false;
  let emittedUsage = false;
  let hasToolCalls = false;
  let latestUsage = fallbackUsage;
  let usageRecorded = false;
  const stopSequences = normalizeStopSequences(stop);
  let pendingStopText = '';
  const toolIndexes = new Map<string, number>();
  const toolCallIds = new Map<string, string>();
  const customToolCallIds = new Set<string>();
  const closedCustomToolCallIds = new Set<string>();
  let nextToolIndex = 0;
  let stoppedLocally = false;

  const getToolIndex = (itemId: string): number => {
    const existing = toolIndexes.get(itemId);
    if (existing !== undefined) return existing;
    const index = nextToolIndex;
    nextToolIndex += 1;
    toolIndexes.set(itemId, index);
    return index;
  };

  const encodeChunk = (choice: Record<string, unknown>): Uint8Array => {
    return encoder.encode(
      `data: ${JSON.stringify({
        choices: [choice],
        created: Math.floor(Date.now() / 1000),
        id: responseId,
        model,
        object: 'chat.completion.chunk',
      })}\n\n`,
    );
  };

  const enqueueUsage = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (!includeUsage || emittedUsage) return;
    const usage = mapResponsesUsageToChat(latestUsage);
    if (!usage) return;

    emittedUsage = true;
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          choices: [],
          created: Math.floor(Date.now() / 1000),
          id: responseId,
          model,
          object: 'chat.completion.chunk',
          usage,
        })}\n\n`,
      ),
    );
  };

  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route,
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route,
      });
    }
  };

  const cancelAndReleaseReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader?.cancel(reason);
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to cancel Responses stream', {
        error,
        route,
      });
    } finally {
      reader?.releaseLock();
      reader = null;
    }
  };

  const emitCustomToolCallClosures = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    customToolCallIds.forEach((itemId) => {
      if (closedCustomToolCallIds.has(itemId)) return;
      const index = getToolIndex(itemId);
      const callId = toolCallIds.get(itemId) ?? `call_${index + 1}`;
      controller.enqueue(
        encodeChunk({
          delta: {
            tool_calls: [{ function: { arguments: '"}' }, id: callId, index }],
          },
          index: 0,
        }),
      );
      closedCustomToolCallIds.add(itemId);
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        await recordStreamUsage();
        controller.close();
        return;
      }
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          await recordStreamUsage();
          reader.releaseLock();
          reader = null;
          const timeoutMessage = toUpstreamTimeoutMessage(error);

          if (timeoutMessage !== null) {
            closer.fail(controller, chatStreamErrorChunks(timeoutMessage));
            return;
          }

          controller.error(error);
          return;
        }
        const { done, value } = readResult;
        if (done) {
          if (pendingStopText) {
            controller.enqueue(
              encodeChunk({
                delta: { content: pendingStopText },
                index: 0,
              }),
            );
            pendingStopText = '';
          }
          emitCustomToolCallClosures(controller);
          if (!emittedFinish) {
            controller.enqueue(
              encodeChunk({
                delta: {},
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                index: 0,
              }),
            );
          }
          enqueueUsage(controller);
          controller.enqueue(encodeDoneFrame());
          await recordStreamUsage();
          reader.releaseLock();
          reader = null;
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
          controller.enqueue(
            encoder.encode(
              'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
            ),
          );
          controller.enqueue(encodeDoneFrame());
          await cancelAndReleaseReader();
          await recordStreamUsage();
          controller.close();
          return;
        }
        let emitted = false;
        for (const frame of frames) {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            controller.enqueue(encodeDoneFrame());
            await cancelAndReleaseReader();
            await recordStreamUsage();
            controller.close();
            return;
          }
          const dataLine = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith('data: '));
          if (!dataLine || dataLine === 'data: [DONE]') continue;
          // The upstream here is the chat pipeline, which reports a deadline as
          // a terminal error chunk and closes cleanly. Without this the failure
          // would be reported to the client as an empty successful response.
          const upstreamError = readTimeoutFrame(frame);

          if (upstreamError !== null) {
            closer.fail(controller, chatStreamErrorChunks(upstreamError));
            await cancelAndReleaseReader();
            await recordStreamUsage();
            return;
          }
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              delta?: unknown;
              item?: unknown;
              item_id?: unknown;
              output_index?: unknown;
              error?: unknown;
              response?: unknown;
              type?: unknown;
            };
            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            if (
              stoppedLocally &&
              event.type !== 'response.completed' &&
              event.type !== 'response.incomplete'
            ) {
              continue;
            }
            if (event.type === 'response.output_text.delta') {
              const delta = String(event.delta ?? '');
              if (stopSequences.length) {
                pendingStopText += delta;
                const stopIndex = findFirstStopSequence(
                  pendingStopText,
                  stopSequences,
                );
                if (stopIndex !== null) {
                  const content = pendingStopText.slice(0, stopIndex);
                  if (content) {
                    controller.enqueue(
                      encodeChunk({ delta: { content }, index: 0 }),
                    );
                  }
                  pendingStopText = '';
                  controller.enqueue(
                    encodeChunk({
                      delta: {},
                      finish_reason: 'stop',
                      index: 0,
                    }),
                  );
                  emittedFinish = true;
                  stoppedLocally = true;
                  emitted = true;
                  continue;
                }

                const pendingLength = getPendingStopPrefixLength(
                  pendingStopText,
                  stopSequences,
                );
                const content = pendingStopText.slice(
                  0,
                  pendingStopText.length - pendingLength,
                );
                pendingStopText = pendingLength
                  ? pendingStopText.slice(-pendingLength)
                  : '';
                if (!content) continue;
                controller.enqueue(
                  encodeChunk({ delta: { content }, index: 0 }),
                );
                emitted = true;
                continue;
              }
              controller.enqueue(
                encodeChunk({
                  delta: { content: delta },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.reasoning_summary_text.delta' ||
              event.type === 'response.reasoning_text.delta'
            ) {
              controller.enqueue(
                encodeChunk({
                  delta: { reasoning_content: String(event.delta ?? '') },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.output_item.added' &&
              event.item &&
              typeof event.item === 'object'
            ) {
              const item = event.item as {
                arguments?: unknown;
                call_id?: unknown;
                id?: unknown;
                input?: unknown;
                name?: unknown;
                type?: unknown;
              };
              if (
                item.type !== 'function_call' &&
                item.type !== 'mcp_call' &&
                item.type !== 'custom_tool_call'
              ) {
                continue;
              }
              const isCustomToolCall = item.type === 'custom_tool_call';
              const initialArguments = isCustomToolCall
                ? `{"input":"${JSON.stringify(
                    String(item.input ?? item.arguments ?? ''),
                  ).slice(1, -1)}`
                : String(item.arguments ?? '');
              const itemId = String(item.id ?? item.call_id ?? nextToolIndex);
              const index = getToolIndex(itemId);
              const callId = String(item.call_id ?? item.id ?? itemId);
              toolCallIds.set(itemId, callId);
              if (isCustomToolCall) {
                customToolCallIds.add(itemId);
              }
              hasToolCalls = true;
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: initialArguments,
                          name: String(item.name ?? 'function'),
                        },
                        id: callId,
                        index,
                        type: 'function',
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.function_call_arguments.delta' ||
              event.type === 'response.mcp_call_arguments.delta' ||
              event.type === 'response.custom_tool_call_input.delta'
            ) {
              const itemId = String(
                event.item_id ?? event.output_index ?? nextToolIndex,
              );
              const index = getToolIndex(itemId);
              const callId = toolCallIds.get(itemId) ?? `call_${index + 1}`;
              toolCallIds.set(itemId, callId);
              hasToolCalls = true;
              const argumentDelta =
                event.type === 'response.custom_tool_call_input.delta'
                  ? JSON.stringify(String(event.delta ?? '')).slice(1, -1)
                  : String(event.delta ?? '');
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: argumentDelta },
                        id: callId,
                        index,
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (event.type === 'response.completed') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              emitCustomToolCallClosures(controller);
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encodeDoneFrame());
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (event.type === 'response.incomplete') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              emitCustomToolCallClosures(controller);
              const incompleteReason =
                event.response && typeof event.response === 'object'
                  ? (
                      (event.response as { incomplete_details?: unknown })
                        .incomplete_details as { reason?: unknown } | undefined
                    )?.reason
                  : undefined;
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason:
                      incompleteReason === 'content_filter'
                        ? 'content_filter'
                        : 'length',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encodeDoneFrame());
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (
              event.type === 'response.failed' ||
              event.type === 'response.error' ||
              event.type === 'error'
            ) {
              const failure =
                event.error ??
                (event.response && typeof event.response === 'object'
                  ? (event.response as { error?: unknown }).error
                  : undefined);
              const message =
                failure && typeof failure === 'object'
                  ? String(
                      (failure as { message?: unknown }).message ?? failure,
                    )
                  : String(failure ?? 'Upstream Responses stream failed');
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { message } })}\n\n`,
                ),
              );
              controller.enqueue(encodeDoneFrame());
              await cancelAndReleaseReader();
              await recordStreamUsage();
              controller.close();
              return;
            }
          } catch {
            // Ignore malformed upstream events and continue reading.
          }
        }
        if (stoppedLocally) continue;
        if (emitted) return;
      }
    },
    async cancel(reason) {
      await cancelAndReleaseReader(reason);
      await recordStreamUsage();
    },
  });

  return createSseResponse(stream, {
    headers: CORS_HEADERS,
    status: upstreamResponse.status,
  });
};
