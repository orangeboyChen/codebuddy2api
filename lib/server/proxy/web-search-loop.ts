import {
  getActiveConfig,
  getCodeBuddyApiEndpoint,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../domain/config';
import { resolveFetchProvider, resolveSearchProvider } from '../search';
import { normalizeSearchBackend } from '../search/tool';
import type { WebFetchProvider, WebSearchProvider } from '../search/types';
import { encodeDoneFrame } from '../shared/sse';

import type { ChatRequestBody } from './codebuddy';
import {
  isLocalServerToolCall,
  isWebFetchTool,
  isWebSearchTool,
  replaceServerTools,
} from './server-tool/classify';
import {
  buildServerToolInvocation,
  executeServerToolInvocations,
} from './server-tool/execution';
import {
  buildServerToolFailureResponse,
  parseBufferedPayload,
  readBufferedChatCompletionPayload,
} from './server-tool/payload';
import { synthesizeChatCompletionStream } from './server-tool/sse';
import {
  type ServerToolProbe,
  probeServerToolStream,
} from './server-tool/stream';
import {
  buildMixedTurnPayload,
  readReasoning,
  sumUsage,
  withIntermediateTurns,
} from './server-tool/turns';
import {
  MAX_SEARCH_ITERATIONS,
  SERVER_TOOL_STREAM_EVENT_KEY,
  type ChatCompletionMessage,
  type ChatCompletionPayload,
  type ChatCompletionToolCall,
  type JsonRecord,
  type ServerToolCallbacks,
  type ServerToolExecution,
  type ServerToolLoopResult,
  type ServerToolStreamEvent,
  type ServerToolTurn,
  type ServerToolUpstreamMode,
} from './server-tool/types';

/**
 * Server-side web search for upstreams that do not implement it.
 *
 * Anthropic (`web_search_20260209`) and the Responses API
 * (`web_search_preview`) both hand search to the provider. CodeBuddy has no
 * equivalent, so when a client declares one of those tools the proxy swaps it
 * for a plain `web_search` function the model can call, runs the query through
 * the configured search backend, and appends the results as a tool message.
 * The model then answers normally, and the client never learns the search ran
 * locally.
 *
 * A streaming first response is probed until its first meaningful delta. Plain
 * text and reasoning keep the real upstream stream, while a server-tool call
 * is buffered because its arguments are only complete once that response ends.
 */

const createInlineServerToolStream = async ({
  body,
  callbacks,
  callUpstream,
  fetchProvider,
  ownedNames,
  searchProvider,
}: {
  body: ChatRequestBody;
  callbacks: ServerToolCallbacks;
  callUpstream: (
    body: ChatRequestBody,
    mode: ServerToolUpstreamMode,
  ) => Promise<Response>;
  fetchProvider: WebFetchProvider | null;
  ownedNames?: Set<string>;
  searchProvider: WebSearchProvider | null;
}): Promise<ServerToolLoopResult> => {
  const firstResponse = await callUpstream(body, 'stream');
  const contentType = firstResponse.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('text/event-stream')) {
    return { body, executions: [], response: firstResponse, turns: [] };
  }

  const executions: ServerToolExecution[] = [];
  const encoder = new TextEncoder();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  // A call is locally executable only when its backend is available; anything
  // else stays the client's to answer.
  const isLocalCall = (toolCall: ChatCompletionToolCall): boolean =>
    isLocalServerToolCall({
      fetchProvider,
      ownedNames,
      searchProvider,
      toolCall,
    });

  const emitJson = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: Record<string, unknown>,
  ): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const emitServerToolEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ServerToolStreamEvent,
  ): void => {
    emitJson(controller, { [SERVER_TOOL_STREAM_EVENT_KEY]: event });
  };
  const pipeResponse = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    response: Response,
  ): Promise<void> => {
    if (!response.body) return;
    const reader = response.body.getReader();
    activeReader = reader;

    while (true) {
      const chunk = await reader.read();
      if (cancelled || chunk.done) break;
      controller.enqueue(chunk.value);
    }

    reader.releaseLock();
    activeReader = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const run = async (): Promise<void> => {
        activeReader = firstResponse.body!.getReader();
        activeReader.releaseLock();
        const context = {
          responseCreated: Math.floor(Date.now() / 1000),
          responseId: '',
          responseModel: String(body.model ?? 'unknown'),
          responseObject: 'chat.completion',
          role: 'assistant',
          usage: null as unknown,
        };

        const first = await probeServerToolStream({
          canContinue: () => !cancelled,
          context,
          emitRaw: (frame) =>
            controller.enqueue(encoder.encode(`${frame}\n\n`)),
          fetchProvider,
          onReader: (reader) => {
            activeReader = reader;
          },
          ownedNames,
          response: firstResponse,
          searchProvider,
        });
        if (cancelled) return;
        activeReader = null;

        let usage: unknown = context.usage;
        const content = first.content;
        const reasoning = first.reasoning;
        const role = context.role;

        const responseId = context.responseId;
        const responseModel = context.responseModel;
        const responseObject = context.responseObject;
        const responseCreated = context.responseCreated;

        if (!first.localCalls.length) {
          first.frames.forEach((frame) =>
            controller.enqueue(encoder.encode(`${frame}\n\n`)),
          );
          controller.close();
          return;
        }

        const remainingCalls = first.remainingCalls;
        const invocations = first.localCalls.map((toolCall, index) =>
          buildServerToolInvocation(toolCall, 0, index),
        );

        invocations.forEach((invocation) => {
          callbacks.onCall?.(invocation);
          emitServerToolEvent(controller, { invocation, phase: 'call' });
        });
        const results = await executeServerToolInvocations({
          callbacks: {
            onResult: (execution) => {
              callbacks.onResult?.(execution);
              emitServerToolEvent(controller, { execution, phase: 'result' });
            },
          },
          fetchProvider,
          invocations,
          searchProvider,
        });
        if (cancelled) return;
        executions.push(...results.map((result) => result.execution));

        if (remainingCalls.length) {
          // Same opt-out as `buildMixedTurnPayload`: the result event above
          // already carries these findings, so a text copy would be the second.
          const findings = callbacks.findingsAsStructuredBlocks
            ? ''
            : results.map((result) => result.content).join('\n\n');
          if (findings) {
            emitJson(controller, {
              choices: [{ delta: { content: findings }, index: 0 }],
              created: responseCreated,
              id: responseId,
              model: responseModel,
              object: `${responseObject}.chunk`,
            });
          }
          emitJson(controller, {
            choices: [
              {
                delta: { tool_calls: remainingCalls },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
            created: responseCreated,
            id: responseId,
            model: responseModel,
            object: `${responseObject}.chunk`,
            usage,
          });
          controller.enqueue(encodeDoneFrame());
          controller.close();
          return;
        }

        const messages = body.messages as JsonRecord[];
        const assistantMessage: JsonRecord = {
          role,
          content: content || null,
          tool_calls: first.toolCalls,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        };
        messages.push(assistantMessage);
        messages.push(
          ...results.map((result) => ({
            role: 'tool',
            tool_call_id: result.tool_call_id,
            content: result.content,
          })),
        );

        let loopBody: ChatRequestBody = {
          ...body,
          messages,
          tool_choice: body.tool_choice ? 'auto' : body.tool_choice,
        };
        let finalPayload: ChatCompletionPayload | null = null;

        for (
          let iteration = 1;
          iteration < MAX_SEARCH_ITERATIONS;
          iteration++
        ) {
          const response = await callUpstream(loopBody, 'stream');
          const isEventStream = (response.headers.get('content-type') ?? '')
            .toLowerCase()
            .includes('text/event-stream');

          // Upstream answers with JSON rather than SSE when it refuses the
          // request, and also when the caller is not streaming at all. Both
          // shapes are read the same way; only an error ends the turn here.
          const buffered = !isEventStream
            ? await readBufferedChatCompletionPayload(response)
            : null;

          let probe: ServerToolProbe | null = null;

          if (buffered) {
            usage = sumUsage(usage, buffered.usage);

            if (!response.ok || buffered.error) {
              emitJson(controller, buffered as JsonRecord);
              controller.enqueue(encodeDoneFrame());
              controller.close();
              return;
            }

            const bufferedMessage = buffered.choices?.[0]?.message;
            const bufferedCalls = bufferedMessage?.tool_calls ?? [];

            // A JSON answer that still asks for a server tool is an
            // intermediate step, not the end of the turn: it has to be
            // executed and fed back, exactly as a streamed one would be.
            if (!bufferedCalls.some(isLocalCall)) {
              finalPayload = {
                ...buffered,
                ...(usage ? { usage } : {}),
              };
              break;
            }

            probe = {
              content:
                typeof bufferedMessage?.content === 'string'
                  ? bufferedMessage.content
                  : '',
              frames: [],
              localCalls: bufferedCalls.filter(isLocalCall),
              reasoning: readReasoning(bufferedMessage),
              remainingCalls: bufferedCalls.filter(
                (toolCall) => !isLocalCall(toolCall),
              ),
              role: bufferedMessage?.role ?? 'assistant',
              toolCalls: bufferedCalls,
              usage,
            };
          } else {
            // Streamed rather than buffered: this is the iteration that very
            // often ends the turn, and buffering it would make the user wait
            // for the whole answer before seeing any of it. Text is forwarded
            // as it arrives; only tool-call frames are held, since a server
            // tool still has to be answered locally.
            probe = await probeServerToolStream({
              canContinue: () => !cancelled,
              context,
              emitRaw: (frame) =>
                controller.enqueue(encoder.encode(`${frame}\n\n`)),
              fetchProvider,
              onReader: (reader) => {
                activeReader = reader;
              },
              ownedNames,
              response,
              searchProvider,
            });
            if (cancelled) return;
            activeReader = null;
            usage = sumUsage(usage, context.usage);

            // No server tool to answer, so the held frames — withheld only
            // because they *might* have been one — are forwarded as-is.
            if (!probe.localCalls.length) {
              probe.frames.forEach((frame) =>
                controller.enqueue(encoder.encode(`${frame}\n\n`)),
              );
              controller.close();
              return;
            }
          }

          // The model is going to search again, so anything it just said is
          // part of the visible turn rather than a discarded step. A streamed
          // iteration already forwarded it through `emitRaw`, so only a
          // buffered one — whose payload never reached the client — needs it
          // re-emitted here.
          const iterationText = buffered ? probe.content.trim() : '';
          const iterationReasoning = buffered ? probe.reasoning.trim() : '';

          if (iterationText) {
            emitJson(controller, {
              choices: [{ delta: { content: iterationText }, index: 0 }],
              created: context.responseCreated,
              id: responseId,
              model: responseModel,
              object: `${responseObject}.chunk`,
            });
          }

          if (iterationReasoning) {
            emitJson(controller, {
              choices: [
                { delta: { reasoning_content: iterationReasoning }, index: 0 },
              ],
              created: context.responseCreated,
              id: responseId,
              model: responseModel,
              object: `${responseObject}.chunk`,
            });
          }

          const message: ChatCompletionMessage = {
            content: probe.content || null,
            role: probe.role,
            tool_calls: probe.toolCalls,
            ...(probe.reasoning ? { reasoning_content: probe.reasoning } : {}),
          };
          const nextLocalCalls = probe.localCalls;
          const nextRemainingCalls = probe.remainingCalls;

          const nextInvocations = nextLocalCalls.map((toolCall, index) =>
            buildServerToolInvocation(toolCall, iteration, index),
          );
          nextInvocations.forEach((invocation) => {
            callbacks.onCall?.(invocation);
            emitServerToolEvent(controller, { invocation, phase: 'call' });
          });
          const nextResults = await executeServerToolInvocations({
            callbacks: {
              onResult: (execution) => {
                callbacks.onResult?.(execution);
                emitServerToolEvent(controller, {
                  execution,
                  phase: 'result',
                });
              },
            },
            fetchProvider,
            invocations: nextInvocations,
            searchProvider,
          });
          if (cancelled) return;
          executions.push(...nextResults.map((result) => result.execution));

          if (nextRemainingCalls.length) {
            finalPayload = buildMixedTurnPayload({
              findingsAsStructuredBlocks: callbacks?.findingsAsStructuredBlocks,
              message,
              payload: {
                choices: [{ message }],
                created: context.responseCreated,
                id: responseId,
                model: responseModel,
                object: responseObject,
              },
              remainingCalls: nextRemainingCalls,
              searchResults: nextResults.map((result) => result.content),
              usage,
            });
            break;
          }

          messages.push(message as JsonRecord);
          messages.push(
            ...nextResults.map((result) => ({
              role: 'tool',
              tool_call_id: result.tool_call_id,
              content: result.content,
            })),
          );
          loopBody = {
            ...loopBody,
            messages,
            tool_choice: loopBody.tool_choice ? 'auto' : loopBody.tool_choice,
          };
        }

        if (!finalPayload) {
          const response = await callUpstream(
            {
              ...loopBody,
              tools: loopBody.tools?.filter(
                (tool) => !isWebSearchTool(tool) && !isWebFetchTool(tool),
              ),
            },
            'stream',
          );
          const isEventStream = (response.headers.get('content-type') ?? '')
            .toLowerCase()
            .includes('text/event-stream');

          if (!isEventStream) {
            finalPayload = await readBufferedChatCompletionPayload(response);

            if (!response.ok || finalPayload.error) {
              emitJson(controller, finalPayload as JsonRecord);
              controller.enqueue(encodeDoneFrame());
              controller.close();
              return;
            }

            usage = sumUsage(usage, finalPayload.usage);
            finalPayload = { ...finalPayload, ...(usage ? { usage } : {}) };
          } else {
            const probe = await probeServerToolStream({
              canContinue: () => !cancelled,
              context,
              emitRaw: (frame) =>
                controller.enqueue(encoder.encode(`${frame}\n\n`)),
              fetchProvider,
              onReader: (reader) => {
                activeReader = reader;
              },
              ownedNames,
              response,
              searchProvider,
            });
            if (cancelled) return;
            activeReader = null;
            usage = sumUsage(usage, context.usage);

            // With every server tool stripped, a tool call here can only be a
            // client-owned one; hand it back so the client resolves it.
            if (probe.remainingCalls.length) {
              const fallbackMessage: ChatCompletionMessage = {
                content: probe.content || null,
                role: probe.role,
                tool_calls: probe.toolCalls,
                ...(probe.reasoning
                  ? { reasoning_content: probe.reasoning }
                  : {}),
              };

              finalPayload = buildMixedTurnPayload({
                findingsAsStructuredBlocks:
                  callbacks?.findingsAsStructuredBlocks,
                message: fallbackMessage,
                payload: {
                  choices: [{ message: fallbackMessage }],
                  created: context.responseCreated,
                  id: responseId,
                  model: responseModel,
                  object: responseObject,
                },
                remainingCalls: probe.remainingCalls,
                searchResults: [],
                usage,
              });
            } else {
              probe.frames.forEach((frame) =>
                controller.enqueue(encoder.encode(`${frame}\n\n`)),
              );
              controller.close();
              return;
            }
          }
        }

        await pipeResponse(
          controller,
          synthesizeChatCompletionStream(
            finalPayload,
            String(loopBody.model ?? 'unknown'),
          ),
        );
        controller.close();
      };

      void run().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await activeReader?.cancel(reason);
      } finally {
        activeReader?.releaseLock();
        activeReader = null;
      }
    },
  });

  return {
    body,
    executions,
    response: new Response(stream, {
      headers: firstResponse.headers,
      status: firstResponse.status,
      statusText: firstResponse.statusText,
    }),
    // The streamed path already emits each hop in order, so no grouping has
    // to be reconstructed downstream.
    turns: [],
  };
};

export const executeWebSearchLoop = async ({
  body,
  callUpstream,
  callbacks,
  detectInitialStream = Boolean(body.stream),
}: {
  body: ChatRequestBody;
  callUpstream: (
    body: ChatRequestBody,
    mode: ServerToolUpstreamMode,
  ) => Promise<Response>;
  callbacks?: ServerToolCallbacks;
  detectInitialStream?: boolean;
}): Promise<ServerToolLoopResult | null> => {
  const [searchEnabled, fetchEnabled, config] = await Promise.all([
    isWebSearchEnabled(),
    isWebFetchEnabled(),
    getActiveConfig(),
  ]);

  const resolveEndpoint = getCodeBuddyApiEndpoint;
  const searchProvider = searchEnabled
    ? resolveSearchProvider(
        config.CODEBUDDY_WEB_SEARCH_BACKEND,
        resolveEndpoint,
      )
    : null;
  const fetchProvider = fetchEnabled
    ? resolveFetchProvider(config.CODEBUDDY_WEB_FETCH_BACKEND, resolveEndpoint)
    : null;

  const replacement = replaceServerTools({
    fetchEnabled,
    fetchProvider,
    searchEnabled,
    searchPassthrough:
      normalizeSearchBackend(config.CODEBUDDY_WEB_SEARCH_BACKEND) ===
      'passthrough',
    searchProvider,
    tools: body.tools,
  });

  if (!replacement) {
    return null;
  }

  const { executes, ownedNames, tools } = replacement;

  // Nothing can be executed, so there is nothing to loop for. The rewritten
  // `tools` still have to reach the caller: it forwards them upstream, and the
  // stripped declarations have to stay stripped on that path too.
  if (!executes) {
    return {
      body: { ...body, tools },
      executions: [],
      response: null,
      turns: [],
    };
  }

  const messages: JsonRecord[] = body.messages as JsonRecord[];
  let loopBody: ChatRequestBody = { ...body, messages, tools };
  let response: Response | null = null;
  let payload: ChatCompletionPayload | null = null;
  let usage: unknown = null;
  const executions: ServerToolExecution[] = [];
  // Text and reasoning the model produced before a *later* server-tool call.
  // Only the last iteration's message survives in `payload`, so a multi-hop
  // turn has to carry its earlier steps forward explicitly.
  const intermediateTexts: string[] = [];
  const intermediateReasonings: string[] = [];
  // The calls each hop made, parallel to the two arrays above. Block renderers
  // need the calls grouped with the prose that produced them, not flattened
  // into one list at the end.
  const intermediateExecutions: ServerToolExecution[][] = [];
  const initialMode: ServerToolUpstreamMode =
    searchProvider && fetchProvider
      ? 'detect-both'
      : searchProvider
        ? 'detect-search'
        : 'detect-fetch';

  if (detectInitialStream && callbacks?.emitStreamEvents) {
    return await createInlineServerToolStream({
      body: loopBody,
      callbacks,
      callUpstream,
      fetchProvider,
      ownedNames,
      searchProvider,
    });
  }

  for (let iteration = 0; iteration < MAX_SEARCH_ITERATIONS; iteration++) {
    response = await callUpstream(
      loopBody,
      iteration === 0 && detectInitialStream ? initialMode : 'buffer',
    );

    if (
      response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
    ) {
      return { body: loopBody, executions, response, turns: [] };
    }

    // The payload is only needed to detect a tool call or a failure, so read
    // the body once and reuse it: the caller reads it again to build the
    // client's answer, and a spent body would surface as a 500.
    const buffered = await response.clone().text();
    payload = parseBufferedPayload(buffered, response.ok);

    if (!response.ok || payload.error) {
      return {
        body: loopBody,
        executions,
        response: await buildServerToolFailureResponse(response),
        turns: [],
      };
    }

    usage = sumUsage(usage, payload.usage);

    const message = payload.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    // The same ownership test the streaming paths use. Matching the name alone
    // would execute a client's own `web_fetch` whenever a backend is
    // configured, instead of handing the call back.
    const isLocalCall = (toolCall: ChatCompletionToolCall): boolean =>
      isLocalServerToolCall({
        fetchProvider,
        ownedNames,
        searchProvider,
        toolCall,
      });
    const localCalls = toolCalls.filter(isLocalCall);
    const remainingCalls = toolCalls.filter(
      (toolCall) => !isLocalCall(toolCall),
    );

    if (!localCalls.length) {
      break;
    }

    const iterationText =
      typeof message?.content === 'string' ? message.content.trim() : '';
    const iterationReasoning = readReasoning(message).trim();

    const invocations = localCalls.map((toolCall, index) =>
      buildServerToolInvocation(toolCall, iteration, index),
    );
    const results = await executeServerToolInvocations({
      callbacks,
      fetchProvider,
      invocations,
      searchProvider,
    });
    executions.push(...results.map((result) => result.execution));

    // A turn mixing server tools with client-side calls cannot be continued
    // locally: the client owns those calls, and re-issuing the transcript with
    // only server-tool results would leave them unanswered, which upstream
    // rejects as an invalid tool-call transcript. Run the server tools and
    // hand the outstanding calls back so the client resolves them on its next
    // turn. The findings ride along in the message text only for routes that
    // cannot render them structurally; see `buildMixedTurnPayload`.
    if (remainingCalls.length) {
      const { payload: folded, turns: priorTurns } = withIntermediateTurns({
        executions: intermediateExecutions,
        payload,
        reasonings: intermediateReasonings,
        texts: intermediateTexts,
      });
      // The hops already run, plus this one's own: it called server tools
      // before handing the client's calls back, so it is a hop like any other
      // and has to stay grouped with them. Dropping it would leave the block
      // renderer with no grouping at all, flattening every hop's prose ahead
      // of the tool blocks.
      //
      // `withIntermediateTurns` already built this hop as its closing entry —
      // the one that carries the current message's prose — but without the
      // calls, because it runs before they exist. So the calls are added to
      // that entry rather than appended as a new hop, which would repeat the
      // prose. Only when there are no earlier hops does it return nothing and
      // a fresh entry has to be built here.
      const currentTurn: ServerToolTurn = {
        // With no earlier hops there is no closing entry to carry the prose,
        // so this hop's own text and reasoning are used directly. They are
        // what `withIntermediateTurns` folded into `folded` above, and a block
        // renderer renders purely from `turns` once it is non-empty, so
        // leaving them out would drop everything the model said here.
        ...(priorTurns.at(-1) ?? {
          reasoning: iterationReasoning,
          text: iterationText,
        }),
        executions: results.map((result) => result.execution),
      };
      const mixedTurns: ServerToolTurn[] = [
        ...priorTurns.slice(0, -1),
        currentTurn,
      ];
      const mixed = buildMixedTurnPayload({
        findingsAsStructuredBlocks: callbacks?.findingsAsStructuredBlocks,
        // `buildMixedTurnPayload` reads this iteration's text and reasoning
        // off `message`, so only the earlier iterations go on top; the
        // current one is folded in by the helper itself.
        message: folded.choices?.[0]?.message,
        payload,
        remainingCalls,
        searchResults: results.map((result) => result.content),
        usage,
      });

      return {
        body: loopBody,
        executions,
        response: Response.json(mixed, { status: response.status }),
        turns: mixedTurns,
      };
    }

    // This iteration is complete and the loop continues, so its prose and the
    // calls it made both become part of the turn the client sees. Keep the three
    // arrays index-aligned: entry N is hop N, so a renderer can pair that hop's
    // reasoning, text, and tool calls without guessing. A hop that called tools
    // without speaking first still gets an entry — its prose sides stay empty.
    const hop = intermediateTexts.length;

    intermediateTexts[hop] = iterationText;
    intermediateReasonings[hop] = iterationReasoning;
    intermediateExecutions[hop] = results.map((result) => result.execution);

    messages.push(message as JsonRecord);
    messages.push(
      ...results.map((result) => ({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: result.content,
      })),
    );

    // A forced tool_choice would make the model call a server tool forever;
    // once the loop is running, let it decide when it has enough.
    loopBody = {
      ...loopBody,
      messages,
      tool_choice: loopBody.tool_choice ? 'auto' : loopBody.tool_choice,
    };
    payload = null;
  }

  // The budget ran out with the model still asking to search or fetch. Drop
  // every server tool and ask once more so it answers with what it has: looping
  // forever would hang the request, and returning `null` would hand the
  // unfinished tool call back to the client, which has no way to resolve it.
  if (!payload) {
    const finalResponse = await callUpstream(
      {
        ...loopBody,
        tools: loopBody.tools!.filter(
          (tool) => !isWebSearchTool(tool) && !isWebFetchTool(tool),
        ),
      },
      'buffer',
    );
    // Cloned before the read so the failure path can replay the body verbatim
    // rather than hand back a spent response the caller cannot read again.
    const finalBuffered = await finalResponse.clone().text();
    payload = parseBufferedPayload(finalBuffered, finalResponse.ok);

    usage = sumUsage(usage, payload.usage);

    if (!finalResponse.ok || payload.error) {
      return {
        body: loopBody,
        executions,
        response: await buildServerToolFailureResponse(finalResponse),
        turns: [],
      };
    }

    const final = withIntermediateTurns({
      executions: intermediateExecutions,
      payload,
      reasonings: intermediateReasonings,
      texts: intermediateTexts,
    });

    return {
      body: loopBody,
      executions,
      response: Response.json(
        {
          ...final.payload,
          ...(usage ? { usage } : {}),
        },
        { status: finalResponse.status },
      ),
      turns: final.turns,
    };
  }

  const final = withIntermediateTurns({
    executions: intermediateExecutions,
    payload,
    reasonings: intermediateReasonings,
    texts: intermediateTexts,
  });

  return {
    body: loopBody,
    executions,
    response: Response.json(
      {
        ...final.payload,
        ...(usage ? { usage } : {}),
      },
      { status: response!.status },
    ),
    turns: final.turns,
  };
};

export type {
  ChatCompletionMessage,
  ChatCompletionPayload,
  ChatCompletionToolCall,
  ServerToolCallbacks,
  ServerToolExecution,
  ServerToolInvocation,
  ServerToolLoopResult,
  ServerToolStreamEvent,
  ServerToolTurn,
  ServerToolUpstreamMode,
} from './server-tool/types';

export {
  attachServerToolExecutions,
  attachServerToolTurns,
  getServerToolExecutions,
  getServerToolStreamEvent,
  getServerToolTurns,
} from './server-tool/execution';

export { synthesizeChatCompletionStream } from './server-tool/sse';

export { withIntermediateTurns } from './server-tool/turns';
