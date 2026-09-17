// ---------------------------------------------------------------------------
// Responses streaming orchestration
//
// Chooses how a Responses request is served — delegated to the image
// generation loop, bridged as a live server-tool stream, or mapped one chat
// SSE chunk at a time — and owns the session persistence for the result.
// ---------------------------------------------------------------------------

import type { NextRequest } from 'next/server';

import { isWebFetchEnabled, isWebSearchEnabled } from '../domain/config';
import type { DebugTrace } from '../domain/debug';
import {
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../search/tool';
import { createSseResponse, encodeDoneFrame } from '../shared/sse';
import { proxyChatCompletions, type ProxyContext } from './codebuddy';
import { executeImageGenerationLoop } from './image-generation';
import {
  buildResponsesWebSearchCallItem,
  mapChatResponseToResponsesStream,
} from './responses-payload';
import { createResponseId } from './responses-ids';

import { mapChatStreamToResponsesEventStream } from './responses-stream';
import {
  hasImageGenerationTool,
  normalizeTranscriptMessageToolNames,
  translateResponsesToolsToChat,
  translateResponsesToolChoiceToChatWithTools,
} from './responses-tools';
import type {
  ResponsesServerToolItem,
  ResponseSessionDefaults,
  TranscriptMessage,
} from './responses-types';

export const createResponsesEventStream = async (
  request: NextRequest,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  maxOutputTokens: number | undefined,
  proxyContext: ProxyContext,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  const translatedTools = translateResponsesToolsToChat(defaults.tools);
  const translatedToolNames = new Set(
    (
      (translatedTools ?? []) as Array<{
        function: { name: string };
      }>
    ).map((tool) => normalizeToolName(tool.function.name)),
  );
  const [searchEnabled, fetchEnabled] = await Promise.all([
    translatedToolNames.has(normalizeToolName(WEB_SEARCH_TOOL_NAME))
      ? isWebSearchEnabled()
      : false,
    translatedToolNames.has(normalizeToolName(WEB_FETCH_TOOL_NAME))
      ? isWebFetchEnabled()
      : false,
  ]);

  const chatBody = {
    model,
    messages: [
      ...(defaults.instructions
        ? [{ role: 'system', content: defaults.instructions }]
        : []),
      ...normalizeTranscriptMessageToolNames(transcript, defaults.tools),
    ],
    max_tokens: maxOutputTokens,
    stream: true,
    tools: translatedTools,
    tool_choice: translateResponsesToolChoiceToChatWithTools(
      defaults.tools,
      defaults.tool_choice,
    ),
  };

  // Image generation is executed locally, so a streaming request has to be
  // buffered first to see whether the model asked for an image. Without this
  // the call is forwarded as an ordinary function_call the client is expected
  // to resolve — and nothing would ever generate the image.
  //
  // Handled before the server-tool branch below: a turn may declare both, and
  // gating on search/fetch would silently skip generation whenever those were
  // enabled.
  if (hasImageGenerationTool(defaults.tools)) {
    const { executions, response, serverToolExecutions } =
      await executeImageGenerationLoop({
        body: chatBody,
        // Buffered so the tool call can be inspected before any delta reaches
        // the client; the ordinary path below stays live.
        callUpstream: (loopBody) =>
          proxyChatCompletions(
            request,
            { ...loopBody, stream: false } as never,
            proxyContext,
            debugTrace,
            '/v1/responses',
          ),
        context: proxyContext,
        request,
      });

    // Always consumed, even when nothing was generated: the loop has already
    // sent the turn upstream, and re-issuing it would bill twice and could
    // return a different answer than the one inspected.
    if (!response.ok) {
      return response;
    }

    return mapChatResponseToResponsesStream(
      (await response.json()) as Record<string, unknown>,
      defaults,
      transcript,
      model,
      previousResponseId,
      proxyContext,
      executions,
      serverToolExecutions,
    );
  }

  if (!searchEnabled && !fetchEnabled) {
    const upstreamResponse = await proxyChatCompletions(
      request,
      chatBody as never,
      proxyContext,
      debugTrace,
      '/v1/responses',
    );

    return mapChatStreamToResponsesEventStream(
      upstreamResponse,
      defaults,
      transcript,
      model,
      previousResponseId,
      proxyContext,
    );
  }

  const encoder = new TextEncoder();
  const responseId = createResponseId();
  const serverToolItems: ResponsesServerToolItem[] = [];
  const itemsByInvocationId = new Map<string, ResponsesServerToolItem>();
  let nextOutputIndex = 0;
  const allocateOutputIndex = (): number => nextOutputIndex++;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const enqueueEvent = (
        payload: Record<string, unknown> & { type: string },
      ): void => {
        if (cancelled) return;
        controller.enqueue(
          encoder.encode(
            `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      enqueueEvent({
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
          output: [],
        },
      });
      enqueueEvent({
        type: 'response.in_progress',
        response: { id: responseId, status: 'in_progress' },
      });

      const run = async (): Promise<void> => {
        const upstreamResponse = await proxyChatCompletions(
          request,
          {
            model,
            messages: [
              ...(defaults.instructions
                ? [{ role: 'system', content: defaults.instructions }]
                : []),
              ...normalizeTranscriptMessageToolNames(
                transcript,
                defaults.tools,
              ),
            ],
            max_tokens: maxOutputTokens,
            stream: true,
            tools: translatedTools,
            tool_choice: translateResponsesToolChoiceToChatWithTools(
              defaults.tools,
              defaults.tool_choice,
            ),
          },
          proxyContext,
          debugTrace,
          '/v1/responses',
          {
            emitStreamEvents: true,
            onCall: (invocation) => {
              const outputIndex = allocateOutputIndex();
              const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;
              const item = {
                completed: buildResponsesWebSearchCallItem(
                  invocation,
                  'completed',
                  id,
                ),
                inProgress: buildResponsesWebSearchCallItem(
                  invocation,
                  'in_progress',
                  id,
                ),
                outputIndex,
              };
              serverToolItems.push(item);
              itemsByInvocationId.set(invocation.id, item);
              enqueueEvent({
                type: 'response.output_item.added',
                item: item.inProgress,
                output_index: outputIndex,
                response_id: responseId,
              });
              enqueueEvent({
                type: 'response.web_search_call.in_progress',
                item_id: id,
                output_index: outputIndex,
              });
              enqueueEvent({
                type: 'response.web_search_call.searching',
                item_id: id,
                output_index: outputIndex,
              });
            },
            onResult: (execution) => {
              const item = itemsByInvocationId.get(execution.id)!;
              const id = String(item.inProgress.id);
              item.completed = buildResponsesWebSearchCallItem(
                execution,
                'completed',
                id,
              );
              enqueueEvent({
                type: 'response.web_search_call.completed',
                item_id: id,
                output_index: item.outputIndex,
              });
              enqueueEvent({
                type: 'response.output_item.done',
                item: item.completed,
                output_index: item.outputIndex,
                response_id: responseId,
              });
            },
          },
        );

        if (cancelled) {
          await upstreamResponse.body?.cancel();
          return;
        }

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          enqueueEvent({
            type: 'response.error',
            error: { message: 'Upstream request failed' },
          });
          controller.enqueue(encodeDoneFrame());
          controller.close();
          return;
        }

        const mappedResponse = mapChatStreamToResponsesEventStream(
          upstreamResponse,
          defaults,
          transcript,
          model,
          previousResponseId,
          proxyContext,
          responseId,
          serverToolItems,
          false,
          false,
          allocateOutputIndex,
          true,
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
