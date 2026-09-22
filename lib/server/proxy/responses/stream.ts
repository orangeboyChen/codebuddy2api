// ---------------------------------------------------------------------------
// Responses SSE stream mapping
// ---------------------------------------------------------------------------

import { createSseResponse, encodeDoneFrame } from '../../shared/sse';
import {
  createStreamCloser,
  readTimeoutFrame,
  responsesStreamErrorChunks,
  toUpstreamTimeoutMessage,
} from '../../shared/upstream-timeout';
import type { ProxyContext } from '../codebuddy';

import { storeResponseSession } from './session';
import {
  buildResponsesRequestEcho,
  buildResponsesWebSearchCallItem,
} from './payload';
import {
  createMessageId,
  createResponseId,
  createResponseOutputId,
  createResponseReasoningId,
  normalizeToolCallId,
} from './ids';
import {
  buildResponsesToolCallOutputItem,
  getResponsesToolCallArgumentDeltaEventType,
  hasSupportedLongerToolNamePrefix,
} from './tools';
import {
  buildStreamingAssistantTranscriptToolCalls,
  getAssistantTranscriptContent,
  getStreamingToolCallCanonicalKey,
  getStreamingToolCallLookupKeys,
  mapChatUsageToResponses,
  REASONING_PREFIX,
} from './transcript';
import type {
  ChatResponseToolCall,
  ResponsesServerToolItem,
  ResponseSessionDefaults,
  StreamingMessageState,
  StreamingToolCallState,
  TranscriptMessage,
} from './types';
import { getServerToolExecutions } from '../server-tools';
import { MAX_RESPONSE_SESSION_TOTAL_BYTES } from './session';

const MAX_STREAM_BUFFER_LENGTH = 1_000_000;
const MAX_STREAM_TEXT_LENGTH = 2_000_000;
const MAX_TOOL_ARGUMENT_LENGTH = 1_000_000;
const MAX_TOOL_NAME_LENGTH = 256;

export const mapChatStreamToResponsesEventStream = (
  upstreamResponse: Response,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  proxyContext: ProxyContext,
  responseId = createResponseId(),
  providedServerToolItems?: ResponsesServerToolItem[],
  emitOpeningEvents = true,
  emitServerToolLifecycle = true,
  providedOutputIndexAllocator?: () => number,
  rejectErrorPayloads = false,
  /** See `mapChatResponseToResponsesPayload`: the announced `created_at`. */
  announcedCreatedAt?: number,
): Response => {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const createdAt = announcedCreatedAt ?? Math.floor(Date.now() / 1000);
  const serverToolItems =
    providedServerToolItems ??
    getServerToolExecutions(upstreamResponse).map((execution, outputIndex) => {
      const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;

      return {
        completed: buildResponsesWebSearchCallItem(execution, 'completed', id),
        inProgress: buildResponsesWebSearchCallItem(
          execution,
          'in_progress',
          id,
        ),
        outputIndex,
      };
    });
  let outputText = '';
  // Reasoning accumulated from stream deltas. The delta events alone are not
  // replayable — a client needs a reasoning item in the completed output, with
  // a blob of its own, to send anything back on the next turn.
  let streamedReasoning = '';
  // Claimed on the first reasoning delta, which lands before any text, so the
  // item sorts ahead of the message it produced.
  let reasoningOutputIndex: number | null = null;
  let reasoningItemAdded = false;
  // Fixed when the first reasoning delta arrives, so the `output_item.added`
  // event and the completed output reference the same id.
  let reasoningItemId = '';

  let nextOutputIndex =
    serverToolItems.reduce(
      (maximum, item) => Math.max(maximum, item.outputIndex),
      -1,
    ) + 1;
  const allocateOutputIndex =
    providedOutputIndexAllocator ?? (() => nextOutputIndex++);
  const messageState: StreamingMessageState = {
    outputIndex: null,
    outputItemId: createMessageId(),
  };
  let messageAddedEmitted = false;
  const toolCallStates = new Map<string, StreamingToolCallState>();
  const toolCallStateKeys = new Map<string, string>();
  let latestUsage: unknown = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const closer = createStreamCloser();
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let totalToolArgumentLength = 0;
      let streamRejected = false;

      const enqueueEvent = (payload: Record<string, unknown>): void => {
        const eventType =
          typeof payload.type === 'string' ? payload.type : 'message';
        controller.enqueue(
          encoder.encode(
            `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      const buildStreamingMessageItem = (
        status: 'completed' | 'in_progress',
      ): Record<string, unknown> => ({
        id: messageState.outputItemId,
        type: 'message',
        role: 'assistant',
        status,
        content: [
          {
            type: 'output_text',
            text: outputText,
            annotations: [],
          },
        ],
      });

      // Carries the reasoning verbatim rather than encrypted — same reasoning as
      // the non-streaming item above.
      const buildStreamingReasoningItem = (): Record<string, unknown> => ({
        id: reasoningItemId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: streamedReasoning }],
        encrypted_content: `${REASONING_PREFIX}${streamedReasoning}`,
        status: 'completed',
      });

      const ensureReasoningItemAdded = (): void => {
        if (reasoningItemAdded) {
          return;
        }

        reasoningOutputIndex ??= allocateOutputIndex();
        enqueueEvent({
          type: 'response.output_item.added',
          item: buildStreamingReasoningItem(),
          output_index: reasoningOutputIndex,
          response_id: responseId,
        });
        reasoningItemAdded = true;
      };

      const ensureMessageAdded = (): void => {
        if (messageAddedEmitted) {
          return;
        }

        messageState.outputIndex ??= allocateOutputIndex();
        enqueueEvent({
          type: 'response.output_item.added',
          item: buildStreamingMessageItem('in_progress'),
          output_index: messageState.outputIndex,
          response_id: responseId,
        });
        messageAddedEmitted = true;
      };

      if (emitOpeningEvents) {
        enqueueEvent({
          type: 'response.created',
          response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            model,
            output: [],
            status: 'in_progress',
            metadata: defaults.metadata ?? {},
            ...buildResponsesRequestEcho(defaults),
          },
        });
        enqueueEvent({
          type: 'response.in_progress',
          response: {
            id: responseId,
            status: 'in_progress',
          },
        });
      }
      if (emitServerToolLifecycle) {
        serverToolItems.forEach(({ completed, inProgress, outputIndex }) => {
          const itemId = String(inProgress.id);
          enqueueEvent({
            type: 'response.output_item.added',
            item: inProgress,
            output_index: outputIndex,
            response_id: responseId,
          });
          enqueueEvent({
            type: 'response.web_search_call.in_progress',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.web_search_call.searching',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.web_search_call.completed',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.output_item.done',
            item: completed,
            output_index: outputIndex,
            response_id: responseId,
          });
        });
      }

      const maybeEmitToolCallAdded = (
        toolCallState: StreamingToolCallState,
        allowIncompleteName = false,
      ): void => {
        if (toolCallState.addedEmitted) {
          return;
        }

        const shouldWaitForInitialName =
          !allowIncompleteName &&
          Boolean(defaults.tools?.length) &&
          toolCallState.name.length === 0;
        const shouldWaitForMoreName =
          !allowIncompleteName &&
          defaults.tools?.length &&
          toolCallState.name.length > 0 &&
          hasSupportedLongerToolNamePrefix(defaults.tools, toolCallState.name);

        if (shouldWaitForInitialName || shouldWaitForMoreName) {
          return;
        }

        enqueueEvent({
          type: 'response.output_item.added',
          item: buildResponsesToolCallOutputItem(defaults.tools, {
            arguments: '',
            callId: toolCallState.callId,
            id: toolCallState.outputItemId,
            name: toolCallState.name || 'function',
            status: 'in_progress',
          }),
          output_index: toolCallState.outputIndex,
          response_id: responseId,
        });

        toolCallState.addedEmitted = true;
        toolCallState.pendingArgumentDeltas.forEach((delta) => {
          enqueueEvent({
            type: getResponsesToolCallArgumentDeltaEventType(
              defaults.tools,
              toolCallState.name,
            ),
            delta,
            item_id: toolCallState.outputItemId,
            output_index: toolCallState.outputIndex,
            response_id: responseId,
          });
        });
        toolCallState.pendingArgumentDeltas = [];
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            const transcriptToolCalls =
              buildStreamingAssistantTranscriptToolCalls(
                [...toolCallStates.values()],
                defaults.tools,
              );
            try {
              await storeResponseSession({
                accessKeyId: proxyContext.accessKeyId,
                credentialFilename: proxyContext.credentialFilename,
                createdAt: Date.now(),
                id: responseId,
                model,
                transcript: [
                  ...transcript,
                  {
                    role: 'assistant',
                    content: getAssistantTranscriptContent(
                      outputText,
                      transcriptToolCalls,
                    ),
                    ...(transcriptToolCalls
                      ? { tool_calls: transcriptToolCalls }
                      : {}),
                    // Same reason as the non-streaming path: a client that
                    // continues via `previous_response_id` instead of
                    // replaying `output` would otherwise lose the reasoning.
                    ...(streamedReasoning
                      ? { reasoning: streamedReasoning }
                      : {}),
                  },
                ],
                defaults,
                upstreamProtocol: 'chat',
              });
            } catch (error) {
              console.error(
                '[CodeBuddy2API] Failed to persist Responses session',
                error,
              );
              enqueueEvent({
                type: 'response.error',
                error: { message: 'Failed to persist response session' },
              });
              controller.enqueue(encodeDoneFrame());
              releaseReader();
              controller.close();
              return;
            }
            [...toolCallStates.values()].forEach((toolCallState) => {
              maybeEmitToolCallAdded(toolCallState, true);
              enqueueEvent({
                type: 'response.output_item.done',
                item: buildResponsesToolCallOutputItem(defaults.tools, {
                  arguments: toolCallState.arguments,
                  callId: toolCallState.callId,
                  id: toolCallState.outputItemId,
                  name: toolCallState.name || 'function',
                  status: 'completed',
                }),
                output_index: toolCallState.outputIndex,
                response_id: responseId,
              });
              enqueueEvent({
                type: getResponsesToolCallArgumentDeltaEventType(
                  defaults.tools,
                  toolCallState.name,
                ).replace('.delta', '.done'),
                arguments: toolCallState.arguments,
                item_id: toolCallState.outputItemId,
                output_index: toolCallState.outputIndex,
                response_id: responseId,
              });
            });
            if (outputText) {
              ensureMessageAdded();
              enqueueEvent({
                type: 'response.output_text.done',
                item: buildStreamingMessageItem('completed'),
                output_index: messageState.outputIndex,
                response_id: responseId,
                text: outputText,
              });
              enqueueEvent({
                type: 'response.output_item.done',
                item: buildStreamingMessageItem('completed'),
                output_index: messageState.outputIndex,
                response_id: responseId,
              });
            }
            enqueueEvent({
              type: 'response.completed',
              response: {
                id: responseId,
                object: 'response',
                created_at: createdAt,
                completed_at: Math.floor(Date.now() / 1000),
                status: 'completed',
                model,
                output_text: outputText,
                previous_response_id: previousResponseId,
                metadata: defaults.metadata ?? {},
                usage: mapChatUsageToResponses(latestUsage),
                output: [
                  ...serverToolItems.map(({ completed, outputIndex }) => ({
                    item: completed,
                    outputIndex,
                  })),
                  // Streamed reasoning needs the same replayable item the
                  // non-streaming path emits. It sorts ahead of the message by
                  // taking the next index before the message claims its own —
                  // the deltas come first on the wire, so the item order has
                  // to match or a client replaying `output` scrambles it.
                  ...(streamedReasoning && reasoningOutputIndex !== null
                    ? [
                        {
                          item: buildStreamingReasoningItem(),
                          outputIndex: reasoningOutputIndex,
                        },
                      ]
                    : []),
                  ...(outputText && messageState.outputIndex !== null
                    ? [
                        {
                          item: buildStreamingMessageItem('completed'),
                          outputIndex: messageState.outputIndex,
                        },
                      ]
                    : []),
                  ...[...toolCallStates.values()].map((toolCallState) => ({
                    item: buildResponsesToolCallOutputItem(defaults.tools, {
                      arguments: toolCallState.arguments,
                      callId: toolCallState.callId,
                      id: toolCallState.outputItemId,
                      name: toolCallState.name || 'function',
                      status: 'completed',
                    }),
                    outputIndex: toolCallState.outputIndex,
                  })),
                ]
                  .sort((left, right) => left.outputIndex - right.outputIndex)
                  .map(({ item }) => item),
                ...buildResponsesRequestEcho(defaults),
              },
            });
            controller.enqueue(encodeDoneFrame());
            releaseReader();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_BUFFER_LENGTH) {
            buffer = '';
          }

          for (const frame of frames) {
            if (streamRejected) {
              break;
            }
            if (frame.length > MAX_STREAM_BUFFER_LENGTH) {
              continue;
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

            // The upstream here is the chat pipeline, which reports a deadline
            // as a terminal error chunk and closes cleanly. Surfacing it keeps
            // the client from seeing an empty successful response.
            const upstreamError = readTimeoutFrame(frame);

            if (upstreamError !== null) {
              streamRejected = true;
              enqueueEvent({
                type: 'response.error',
                error: { message: upstreamError },
              });
              break;
            }

            try {
              const payload = JSON.parse(raw) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: ChatResponseToolCall[];
                  };
                }>;
                error?: unknown;
                usage?: unknown;
              };
              if (rejectErrorPayloads && payload.error) {
                const error =
                  typeof payload.error === 'object'
                    ? (payload.error as { message?: unknown })
                    : null;
                streamRejected = true;
                enqueueEvent({
                  type: 'response.error',
                  error: {
                    message:
                      typeof error?.message === 'string'
                        ? error.message
                        : typeof payload.error === 'string'
                          ? payload.error
                          : 'Upstream request failed',
                  },
                });
                break;
              }
              // The final upstream chunk carries the aggregated usage, so
              // remember it for the downstream response.completed event.
              if (payload.usage !== undefined) {
                latestUsage = payload.usage;
              }
              const delta = payload.choices?.[0]?.delta;

              if (delta?.content) {
                ensureMessageAdded();
                outputText = `${outputText}${delta.content}`;
                if (outputText.length > MAX_STREAM_TEXT_LENGTH) {
                  throw new Error('Response output exceeds the maximum size');
                }
                enqueueEvent({
                  type: 'response.output_text.delta',
                  delta: delta.content,
                  // Send only the item reference: embedding the accumulated
                  // text re-serializes it on every delta, which makes the
                  // enqueued volume quadratic in the output size. The full
                  // text still arrives intact in response.output_text.done
                  // and response.completed.
                  item_id: messageState.outputItemId,
                  output_index: messageState.outputIndex,
                  response_id: responseId,
                });
              }

              if (delta?.reasoning_content) {
                reasoningItemId ||= createResponseReasoningId();
                streamedReasoning += delta.reasoning_content;
                ensureReasoningItemAdded();
                enqueueEvent({
                  type: 'response.reasoning_text.delta',
                  delta: delta.reasoning_content,
                  response_id: responseId,
                });
              }

              delta?.tool_calls?.forEach((toolCall, position) => {
                const lookupKeys = getStreamingToolCallLookupKeys(
                  toolCall,
                  position,
                );
                const existingCanonicalKey = lookupKeys
                  .map((key) => toolCallStateKeys.get(key) ?? key)
                  .find((key) => toolCallStates.has(key));
                const canonicalKey =
                  existingCanonicalKey ??
                  getStreamingToolCallCanonicalKey(toolCall, position);
                const existing = toolCallStates.get(canonicalKey);
                const outputIndex = existing
                  ? existing.outputIndex
                  : allocateOutputIndex();
                const current = existing ?? {
                  addedEmitted: false,
                  arguments: '',
                  canonicalKey,
                  callId: normalizeToolCallId(toolCall.id, outputIndex),
                  name: '',
                  outputIndex,
                  outputItemId: createResponseOutputId(),
                  pendingArgumentDeltas: [],
                };

                if (toolCall.function?.name) {
                  if (
                    current.name.length + toolCall.function.name.length >
                    MAX_TOOL_NAME_LENGTH
                  ) {
                    throw new Error(
                      'Response tool name exceeds the maximum size',
                    );
                  }
                  current.name += toolCall.function.name;
                }
                maybeEmitToolCallAdded(current);

                if (toolCall.function?.arguments) {
                  if (
                    current.arguments.length +
                      toolCall.function.arguments.length >
                    MAX_TOOL_ARGUMENT_LENGTH
                  ) {
                    throw new Error(
                      'Response tool arguments exceed the maximum size',
                    );
                  }
                  if (
                    totalToolArgumentLength +
                      toolCall.function.arguments.length >
                    MAX_RESPONSE_SESSION_TOTAL_BYTES
                  ) {
                    throw new Error(
                      'Response tool arguments exceed the maximum size',
                    );
                  }
                  totalToolArgumentLength += toolCall.function.arguments.length;
                  current.arguments = `${current.arguments}${toolCall.function.arguments}`;
                  if (current.addedEmitted) {
                    enqueueEvent({
                      type: getResponsesToolCallArgumentDeltaEventType(
                        defaults.tools,
                        current.name,
                      ),
                      delta: toolCall.function.arguments,
                      item_id: current.outputItemId,
                      output_index: current.outputIndex,
                      response_id: responseId,
                    });
                  } else {
                    current.pendingArgumentDeltas.push(
                      toolCall.function.arguments,
                    );
                  }
                }

                toolCallStates.set(canonicalKey, current);
                lookupKeys.forEach((key) => {
                  toolCallStateKeys.set(key, current.canonicalKey);
                });
              });
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.includes('maximum size')
              ) {
                streamRejected = true;
              }
              console.error(
                '[CodeBuddy2API] Failed to parse upstream SSE frame',
                {
                  route: '/v1/responses',
                  frame: raw.slice(0, 1000),
                },
              );
              enqueueEvent({
                type: 'response.error',
                error: {
                  message: 'Failed to parse upstream SSE frame',
                },
              });
            }
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

        streamRejected = true;
        void reader?.cancel().then(
          () => undefined,
          () => undefined,
        );
        releaseReader();
        closer.fail(controller, responsesStreamErrorChunks(timeoutMessage));
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
