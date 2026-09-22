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
import {
  createSseResponse,
  encodeDoneFrame,
  isEventStream,
} from '../../shared/sse';
import { proxyChatCompletions, type ProxyContext } from '../codebuddy';
import { executeImageGenerationLoop } from '../image-generation';
import {
  buildResponsesRequestEcho,
  buildResponsesWebSearchCallItem,
  mapChatResponseToResponsesStream,
} from './payload';
import { createResponseId } from './ids';
import { getUpstreamErrorMessage } from '../anthropic/errors';

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
import type { ServerToolExecution, ServerToolSegment } from '../server-tools';
import {
  hasExecutableServerTool,
  prepareServerToolTurn,
  reconcileToolChoice,
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
  // The image loop drives upstream through `callUpstream`, so prose written
  // before a search has to be captured there rather than at one call site.
  let streamSegments: ServerToolSegment[] | undefined;

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
    // A server tool nothing here can run is withdrawn from `tools`, so a
    // choice forcing it has to go too.
    tool_choice: reconcileToolChoice(
      translateResponsesToolChoiceToChatWithTools(
        defaults.tools,
        defaults.tool_choice,
      ),
      rewrite ? rewrite.tools : translatedTools,
    ),
    // Carried through, not assumed: the chat upstream honours it, so a client
    // that forbids parallel calls gets one tool call at a time.
    parallel_tool_calls: defaults.parallel_tool_calls,
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
  ): Promise<Response> => {
    if (!willRunServerTool || !rewrite) {
      return proxyChatCompletions(
        request,
        { ...loopBody, stream } as never,
        proxyContext,
        debugTrace,
        '/v1/responses',
      );
    }

    const outcome = await withCodeBuddyToken(
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
          signal: request.signal,
        }),
    );

    // Accumulated across iterations: the image loop calls this once per
    // iteration and each outcome carries only that iteration's segments, so
    // first-wins would drop every search after the first. An iteration that ran
    // no server tool contributes an empty array and erases nothing, and
    // `undefined` still means none ran at all — the mapper falls back to
    // `serverToolExecutions` on that distinction.
    if (outcome.segments.length) {
      streamSegments = [...(streamSegments ?? []), ...outcome.segments];
    }

    return outcome.response;
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
      undefined,
      streamSegments,
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
  let nextOutputIndex = 0;
  const allocateOutputIndex = (): number => nextOutputIndex++;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  /**
   * `web_search_call` items for the searches a turn already ran.
   *
   * Nothing announces them live — the turn is buffered throughout, since
   * whether the model wants another search is only knowable once a hop has
   * finished — so the mapper emits the whole lifecycle in one pass when the
   * answer is replayed.
   */
  const buildSearchItems = (
    executions: ServerToolExecution[],
  ): ResponsesServerToolItem[] =>
    executions.map((execution) => {
      const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;

      return {
        completed: buildResponsesWebSearchCallItem(execution, 'completed', id),
        inProgress: buildResponsesWebSearchCallItem(
          execution,
          'in_progress',
          id,
        ),
        outputIndex: allocateOutputIndex(),
      };
    });

  const createdAt = Math.floor(Date.now() / 1000);

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

      // Announced now, under the id the replay will reuse. The turn is
      // buffered throughout, so without this the client would see nothing
      // until every search and every hop had finished — long enough that a
      // client with an idle timeout would drop the connection.
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
        response: { id: responseId, status: 'in_progress' },
      });

      const run = async (): Promise<void> => {
        const { fetchProvider, searchProvider } = prepared!.providers;

        const { executions, response, segments } = await withCodeBuddyToken(
          () => Promise.resolve(proxyContext.auth.bearerToken),
          () =>
            runServerToolTurn({
              // No onCall/onResult: the turn is buffered, so the lifecycle is
              // replayed from `executions` in one consistent pass instead of
              // being emitted live and then again by the replay.
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
              rewrite: rewrite!,
              searchProvider,
              signal: request.signal,
            }),
        );

        if (cancelled) {
          await response.body?.cancel();
          return;
        }

        if (!response.ok) {
          // The upstream's own words: a rate limit has to arrive as one, or a
          // client that retries on that alone stops retrying.
          enqueueEvent({
            type: 'response.error',
            error: {
              message: await getUpstreamErrorMessage(response).catch(
                () => 'Upstream request failed',
              ),
            },
          });
          controller.enqueue(encodeDoneFrame());
          controller.close();
          return;
        }

        /**
         * The turn is finished before this point, so `response` is a buffered
         * payload, not a live stream — every hop had to complete to know
         * whether the model wanted another search. Handing that to the SSE
         * mapper would find no `data:` frames and drop the answer entirely, so
         * a buffered response is replayed through the buffered→Responses
         * mapper instead.
         */
        const mappedResponse = await (isEventStream(response)
          ? mapChatStreamToResponsesEventStream(
              response,
              defaults,
              transcript,
              model,
              previousResponseId,
              proxyContext,
              responseId,
              buildSearchItems(executions),
              false,
              true,
              allocateOutputIndex,
              true,
              createdAt,
            )
          : mapChatResponseToResponsesStream(
              (await response.json()) as Record<string, unknown>,
              defaults,
              transcript,
              model,
              previousResponseId,
              proxyContext,
              [],
              executions,
              // The id already announced to the client. The mapper persists
              // the session under whatever id it emits, so without this the
              // client is handed an id nothing was stored against, and a
              // follow-up carrying `previous_response_id` fails.
              responseId,
              segments,
              // Already announced above: the replay must not emit a
              // second `response.created` under the same id.
              false,
              createdAt,
            ));
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
