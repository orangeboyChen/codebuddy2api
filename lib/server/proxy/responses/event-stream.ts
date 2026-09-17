// ---------------------------------------------------------------------------
// Responses streaming orchestration
//
// Chooses how a Responses request is served — delegated to the image
// generation loop, bridged as a live server-tool stream, or mapped one chat
// SSE chunk at a time — and owns the session persistence for the result.
// ---------------------------------------------------------------------------

import type { NextRequest } from 'next/server';

import type { DebugTrace } from '../../domain/debug';
import { withCodeBuddyToken } from '../../search/token';
import { createSseResponse, encodeDoneFrame } from '../../shared/sse';
import { proxyChatCompletions, type ProxyContext } from '../codebuddy';
import { executeImageGenerationLoop } from '../image-generation';
import {
  buildResponsesWebSearchCallItem,
  mapChatResponseToResponsesStream,
} from './payload';
import { createResponseId } from './ids';

import { mapChatStreamToResponsesEventStream } from './stream';
import {
  hasImageGenerationTool,
  normalizeTranscriptMessageToolNames,
  translateResponsesToolsToChat,
  translateResponsesToolChoiceToChatWithTools,
} from './tools';
import type {
  ResponsesServerToolItem,
  ResponseSessionDefaults,
  TranscriptMessage,
} from './types';
import {
  hasExecutableServerTool,
  prepareServerToolTurn,
  runServerToolTurn,
} from '../server-tools';

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

  // Classified on the translated tools, which keep a provider-executed
  // declaration's type. A client's own function — including one named
  // `web_search` — arrives as `function` and is left to the client.
  const prepared = await prepareServerToolTurn(translatedTools);
  const rewrite = prepared?.rewrite ?? null;
  const willRunServerTool = Boolean(
    rewrite && hasExecutableServerTool(rewrite.executable),
  );

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
    // Rewritten even when nothing will be executed: upstream has no server
    // tools, so a declared type would be a shape it rejects.
    tools: rewrite ? rewrite.tools : translatedTools,
    tool_choice: translateResponsesToolChoiceToChatWithTools(
      defaults.tools,
      defaults.tool_choice,
    ),
  };

  /**
   * One hop upstream, running any server tool the model asks for on the way.
   *
   * The image loop drives upstream itself, so the turn has to be reachable from
   * here too — a hop can ask for an image and a search at once, and the search
   * still has to run.
   */
  const callUpstream = async (
    loopBody: Record<string, unknown>,
    stream: boolean,
  ): Promise<Response> =>
    willRunServerTool && rewrite
      ? (
          await withCodeBuddyToken(
            () => Promise.resolve(proxyContext.auth.bearerToken),
            () =>
              runServerToolTurn({
                body: loopBody as never,
                callUpstream: (turnBody, turnStream) =>
                  proxyChatCompletions(
                    request,
                    { ...turnBody, stream: turnStream } as never,
                    proxyContext,
                    debugTrace,
                    '/v1/responses',
                  ),
                fetchProvider: prepared!.providers.fetchProvider,
                rewrite,
                searchProvider: prepared!.providers.searchProvider,
                stream,
              }),
          )
        ).response
      : proxyChatCompletions(
          request,
          { ...loopBody, stream } as never,
          proxyContext,
          debugTrace,
          '/v1/responses',
        );

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
        // the client; the ordinary path below stays live. Any server tool the
        // hop asked for runs inside this call, and its lifecycle is replayed
        // from `serverToolExecutions` rather than announced live.
        callUpstream: (loopBody) => callUpstream(loopBody, false),
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

  // Nothing local to run: the request goes upstream as it stands and every tool
  // call comes back to the client.
  if (!willRunServerTool) {
    return mapChatStreamToResponsesEventStream(
      await proxyChatCompletions(
        request,
        chatBody as never,
        proxyContext,
        debugTrace,
        '/v1/responses',
      ),
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
        const { fetchProvider, searchProvider } = prepared!.providers;

        const { response } = await withCodeBuddyToken(
          () => Promise.resolve(proxyContext.auth.bearerToken),
          () =>
            runServerToolTurn({
              body: chatBody as never,
              callUpstream: (body, stream) =>
                proxyChatCompletions(
                  request,
                  { ...body, stream } as never,
                  proxyContext,
                  debugTrace,
                  '/v1/responses',
                ),
              fetchProvider,
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
                const item = itemsByInvocationId.get(execution.id);

                if (!item) {
                  return;
                }

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
              rewrite: rewrite!,
              searchProvider,
              stream: true,
            }),
        );

        if (cancelled) {
          await response.body?.cancel();
          return;
        }

        if (!response.ok) {
          enqueueEvent({
            type: 'response.error',
            error: { message: 'Upstream request failed' },
          });
          controller.enqueue(encodeDoneFrame());
          controller.close();
          return;
        }

        const mappedResponse = mapChatStreamToResponsesEventStream(
          response,
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
