import type { NextRequest } from 'next/server';

import type { DebugTrace } from '../../domain/debug';
import { createSseResponse } from '../../shared/sse';
import {
  anthropicStreamErrorChunks,
  createStreamCloser,
  toUpstreamTimeoutMessage,
} from '../../shared/upstream-timeout';
import { proxyChatCompletions, type ChatRequestBody } from '../codebuddy';
import { createAnthropicId } from './content';
import { anthropicErrorType, getUpstreamErrorMessage } from './errors';
import {
  buildAnthropicServerToolBlocks,
  mapFinishReasonToAnthropic,
  mapOpenAIUsageToAnthropic,
} from './response';
import { MAX_STREAM_FRAME_LENGTH } from './types';
import type {
  OpenAIStreamChunk,
  OpenAIStreamError,
  OpenAIUsage,
  StreamingToolUseState,
} from './types';
import {
  getServerToolExecutions,
  getServerToolStreamEvent,
  type ServerToolExecution,
} from '../web-search-loop';

// ---------------------------------------------------------------------------
// Response translation: OpenAI SSE → Anthropic SSE (streaming)
// ---------------------------------------------------------------------------

export const mapOpenAIStreamToAnthropicSSE = (
  upstreamResponse: Response,
  model: string,
  options?: {
    emitMessageStart?: boolean;
    initialContentBlockCount?: number;
    messageId?: string;
    serverToolExecutions?: ServerToolExecution[];
  },
): Response => {
  if (!upstreamResponse.body) {
    return createSseResponse(null, { status: upstreamResponse.status });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const messageId = options?.messageId ?? createAnthropicId('msg');
  const serverToolExecutions =
    options?.serverToolExecutions ?? getServerToolExecutions(upstreamResponse);
  const serverToolUseIds = new Map<string, string>();
  const toolUseStates = new Map<string, StreamingToolUseState>();
  let nextToolIndex = 0;
  let started = options?.emitMessageStart === false;
  let thinkingStarted = false;
  let thinkingBlockIndex = -1;
  let textStarted = false;
  let textBlockIndex = -1;
  // Tracks how many content blocks (thinking + text) have been opened
  // so tool_use blocks get correct sequential indices even after the
  // prior blocks are closed mid-stream.
  let contentBlockCount = options?.initialContentBlockCount ?? 0;
  let finishReason: string | null = null;
  let hasToolCalls = false;
  let usage: OpenAIUsage | undefined;

  const enqueueEvent = (event: Record<string, unknown>): void => {
    controller.enqueue(
      encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );
  };

  let controller: ReadableStreamDefaultController<Uint8Array>;

  // Close any open text/thinking block before starting a tool_use block.
  // Anthropic streaming requires each block to be stopped before the next.
  const closeOpenTextBlocks = (): void => {
    if (thinkingStarted) {
      // Anthropic emits the signature last, just before the block closes — but
      // we do not send one here: the reasoning already went out as
      // `thinking_delta`s, and duplicating it into a signature would put the
      // text on the wire twice for callers that count it. See
      // `buildThinkingBlock`.
      enqueueEvent({
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      });
      thinkingStarted = false;
    }

    if (textStarted) {
      enqueueEvent({
        type: 'content_block_stop',
        index: textBlockIndex,
      });
      textStarted = false;
    }
  };

  const processChunk = (chunk: OpenAIStreamChunk): void => {
    if (!started) {
      started = true;
      enqueueEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: chunk.usage?.prompt_tokens ?? 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    }

    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (!delta) {
      return;
    }

    // Reasoning / thinking content
    const reasoningText = delta.reasoning_content ?? delta.reasoning ?? '';

    if (reasoningText) {
      if (!thinkingStarted) {
        thinkingBlockIndex = contentBlockCount;
        thinkingStarted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: thinkingBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        });
        contentBlockCount++;
      }

      enqueueEvent({
        type: 'content_block_delta',
        index: thinkingBlockIndex,
        delta: {
          type: 'thinking_delta',
          thinking: reasoningText,
        },
      });
    }

    // Text content
    if (delta.content) {
      if (!textStarted) {
        // Close the thinking block before starting text so Anthropic
        // stream consumers see properly ordered, non-overlapping blocks.
        closeOpenTextBlocks();

        textBlockIndex = contentBlockCount;
        textStarted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        });
        contentBlockCount++;
      }

      enqueueEvent({
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      });
    }

    // Tool calls
    if (delta.tool_calls?.length) {
      hasToolCalls = true;

      // Anthropic streaming requires each content block to be closed
      // before the next one starts. If we already opened a text or
      // thinking block, close it now so the tool_use block is well-formed.
      closeOpenTextBlocks();

      for (const call of delta.tool_calls) {
        const callId = call.id ?? `toolu_${nextToolIndex}`;
        const key = callId;

        if (!toolUseStates.has(key)) {
          const blockIndex = contentBlockCount + nextToolIndex;

          toolUseStates.set(key, {
            id: callId,
            name: '',
            input: '',
            index: blockIndex,
            started: false,
            blockEmitted: false,
          });
          nextToolIndex++;
        }

        const state = toolUseStates.get(key)!;

        // Accumulate name fragments (upstream may stream the function
        // name across multiple deltas, e.g. "look" + "up").
        if (call.function?.name) {
          state.name += call.function.name;
        }

        // Emit content_block_start lazily — once we have a name and at
        // least one arguments fragment, so the block header carries the
        // full tool name instead of a partial fragment.
        if (!state.blockEmitted && state.name && call.function?.arguments) {
          state.blockEmitted = true;
          enqueueEvent({
            type: 'content_block_start',
            index: state.index,
            content_block: {
              type: 'tool_use',
              id: state.id,
              name: state.name,
              input: {},
            },
          });
        }

        if (call.function?.arguments) {
          state.input += call.function.arguments;
          enqueueEvent({
            type: 'content_block_delta',
            index: state.index,
            delta: {
              type: 'input_json_delta',
              partial_json: call.function.arguments,
            },
          });
        }
      }
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  const finalize = (): void => {
    // Close any remaining open text/thinking blocks.
    closeOpenTextBlocks();

    // Close tool use blocks
    for (const [, state] of toolUseStates) {
      // If the block start was never emitted (e.g. name-only deltas
      // with no arguments), emit it now so the block is well-formed.
      if (!state.blockEmitted) {
        state.blockEmitted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: state.index,
          content_block: {
            type: 'tool_use',
            id: state.id,
            name: state.name || 'unknown',
            input: {},
          },
        });
      }

      enqueueEvent({
        type: 'content_block_stop',
        index: state.index,
      });
    }

    const stopReason = mapFinishReasonToAnthropic(finishReason, hasToolCalls);

    enqueueEvent({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: mapOpenAIUsageToAnthropic(usage, serverToolExecutions),
    });

    enqueueEvent({
      type: 'message_stop',
    });
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let streamRejected = false;
  const closer = createStreamCloser();
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      controller = ctrl;
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      const rejectStream = (
        message = 'Upstream SSE frame exceeds the maximum size',
        status?: number,
      ): void => {
        streamRejected = true;
        enqueueEvent({
          type: 'error',
          error: {
            // An upstream status names the failure precisely, so it decides
            // the type: 429 has to arrive as `rate_limit_error` or a client
            // that retries on that type alone stops retrying an exhausted
            // quota. Without one, fall back to the message: an oversized frame
            // is a malformed stream (`invalid_request_error`), while an
            // upstream deadline is the server failing (`api_error`, the type
            // clients treat as retryable).
            type:
              typeof status === 'number'
                ? anthropicErrorType(status)
                : message.includes('did not produce output')
                  ? 'api_error'
                  : 'invalid_request_error',
            message,
          },
        });
      };

      const flushFrames = (frames: string[]): void => {
        for (const frame of frames) {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            rejectStream();
            return;
          }
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

          try {
            const chunk = JSON.parse(raw) as OpenAIStreamChunk;
            const serverToolEvent = getServerToolStreamEvent(chunk);

            if (serverToolEvent?.phase === 'call') {
              closeOpenTextBlocks();
              const index = contentBlockCount++;
              const toolUseId = createAnthropicId('srvtoolu');
              serverToolUseIds.set(serverToolEvent.invocation.id, toolUseId);
              enqueueEvent({
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'server_tool_use',
                  id: toolUseId,
                  name: serverToolEvent.invocation.type,
                  input: {},
                },
              });
              enqueueEvent({
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(
                    serverToolEvent.invocation.input,
                  ),
                },
              });
              enqueueEvent({ type: 'content_block_stop', index });
              continue;
            }

            if (serverToolEvent?.phase === 'result') {
              closeOpenTextBlocks();
              serverToolExecutions.push(serverToolEvent.execution);
              const index = contentBlockCount++;
              const resultBlock = buildAnthropicServerToolBlocks(
                serverToolEvent.execution,
              )[1];
              enqueueEvent({
                type: 'content_block_start',
                index,
                content_block: {
                  ...resultBlock,
                  tool_use_id: serverToolUseIds.get(
                    serverToolEvent.execution.id,
                  ),
                },
              });
              enqueueEvent({ type: 'content_block_stop', index });
              continue;
            }

            const upstreamError = chunk as OpenAIStreamError;
            if (upstreamError.error?.message) {
              rejectStream(
                upstreamError.error.message,
                upstreamError.error.status,
              );
              return;
            }
            processChunk(chunk);
          } catch {
            // Skip unparseable frames
          }
        }
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
            if (!streamRejected) {
              finalize();
            }
            releaseReader();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            rejectStream();
          } else {
            flushFrames(frames);
          }
          if (streamRejected) {
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
        }
      };

      void pump().catch((error) => {
        if (cancelled) return;
        const timeoutMessage = toUpstreamTimeoutMessage(error);

        if (timeoutMessage === null) {
          closer.mark();
          controller.error(error);
          return;
        }

        void reader?.cancel().then(
          () => undefined,
          () => undefined,
        );
        releaseReader();
        closer.fail(controller, anthropicStreamErrorChunks(timeoutMessage));
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

  return createSseResponse(stream, { status: 200 });
};

export const createAnthropicServerToolEventStream = (
  request: NextRequest,
  chatBody: Record<string, unknown>,
  model: string,
  debugTrace?: DebugTrace,
): Response => {
  const encoder = new TextEncoder();
  const messageId = createAnthropicId('msg');
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const enqueueEvent = (event: Record<string, unknown>): void => {
        if (cancelled) return;
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };

      enqueueEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const run = async (): Promise<void> => {
        const upstreamResponse = await proxyChatCompletions(
          request,
          chatBody as ChatRequestBody,
          undefined,
          debugTrace,
          '/v1/messages',
          // The findings reach the client as `web_search_tool_result` blocks,
          // so the loop must not also fold them into the assistant text.
          { emitStreamEvents: true, findingsAsStructuredBlocks: true },
        );

        if (cancelled) {
          await upstreamResponse.body?.cancel();
          return;
        }

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          // A rate limit has to arrive as `rate_limit_error`, or a client that
          // retries on that type alone will treat an exhausted quota as a
          // generic failure and stop retrying — so the upstream status drives
          // the event type even though the envelope is already streaming and
          // the HTTP status cannot be changed.
          const message = upstreamResponse.ok
            ? 'Upstream request failed'
            : await getUpstreamErrorMessage(upstreamResponse).catch(
                () => 'Upstream request failed',
              );

          enqueueEvent({
            type: 'error',
            error: {
              type: anthropicErrorType(upstreamResponse.status),
              message,
            },
          });
          controller.close();
          return;
        }

        const mappedResponse = mapOpenAIStreamToAnthropicSSE(
          upstreamResponse,
          model,
          {
            emitMessageStart: false,
            initialContentBlockCount: 0,
            messageId,
            serverToolExecutions: [],
          },
        );
        const reader = mappedResponse.body!.getReader();
        activeReader = reader;

        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;
          controller.enqueue(value);
        }

        reader.releaseLock();
        activeReader = null;
        controller.close();
      };

      void run().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      await activeReader?.cancel(reason);
      activeReader?.releaseLock();
      activeReader = null;
    },
  });

  return createSseResponse(stream);
};
