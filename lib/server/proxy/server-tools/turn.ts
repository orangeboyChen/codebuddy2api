import {
  getActiveConfig,
  getCodeBuddyApiEndpoint,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../../domain/config';
import { resolveFetchProvider, resolveSearchProvider } from '../../search';
import type { WebFetchProvider, WebSearchProvider } from '../../search/types';
import { asRecord, readReasoning } from '../../shared/content';
import type { ChatRequestBody } from '../codebuddy';
import {
  buildServerToolInvocation,
  executeServerToolInvocations,
} from './execute';
import {
  findServerToolDeclarations,
  getForcedToolName,
  reconcileToolChoice,
  type RewrittenServerTools,
  rewriteServerTools,
} from './classify';
import { readBufferedChatCompletionPayload } from './payload';
import type {
  ChatCompletionMessage,
  ChatCompletionPayload,
  ChatCompletionToolCall,
  JsonRecord,
  ServerToolExecution,
  ServerToolInvocation,
  ServerToolKind,
  ServerToolPreamble,
  ServerToolSegment,
  ServerToolTurnOutcome,
} from './types';
import { attachServerToolExecutions, EMPTY_PREAMBLE, sumUsage } from './types';

/**
 * One server-tool turn.
 *
 * A loop, bounded by the `max_uses` the client declared: ask upstream, run
 * whatever server tools it reached for, feed the findings back, and ask again
 * until the model stops asking or the budget is spent — then one closing call
 * with the server tools withdrawn so it answers with what it has.
 *
 * The loop is over the *server* tools only. Claude Code's own `WebSearch` is an
 * ordinary client function; a call to it is never picked up, because Claude
 * Code wants to resolve it itself. That is the whole distinction this module
 * exists to protect.
 */

/**
 * Resolves the configured backends.
 *
 * A `passthrough` backend resolves to `null`, which is what tells the turn the
 * client runs the tool itself: the declaration is still rewritten into a
 * function upstream can call, but the call that comes back is handed to the
 * client rather than executed here.
 */
export const resolveServerToolBackends = async (): Promise<{
  fetchProvider: WebFetchProvider | null;
  searchProvider: WebSearchProvider | null;
}> => {
  const [searchEnabled, fetchEnabled, config] = await Promise.all([
    isWebSearchEnabled(),
    isWebFetchEnabled(),
    getActiveConfig(),
  ]);
  const resolveEndpoint = getCodeBuddyApiEndpoint;

  return {
    fetchProvider: fetchEnabled
      ? resolveFetchProvider(
          config.CODEBUDDY_WEB_FETCH_BACKEND,
          resolveEndpoint,
        )
      : null,
    searchProvider: searchEnabled
      ? resolveSearchProvider(
          config.CODEBUDDY_WEB_SEARCH_BACKEND,
          resolveEndpoint,
        )
      : null,
  };
};

/**
 * Decides whether `tools` contain a server tool this deployment will run.
 *
 * Takes the already-translated chat tools: both translators keep a
 * provider-executed declaration's type, so this works for Anthropic
 * (`web_search_20250305`) and the Responses API (`web_search_preview`) alike.
 *
 * Returns `null` when no provider-executed tool is declared, in which case the
 * caller forwards the request untouched. Otherwise `rewrite.tools` must be sent
 * upstream whether or not anything will be executed: upstream has no server
 * tools, and leaving a declared type in the request sends a shape it rejects.
 */
export const prepareServerToolTurn = async (
  tools: unknown,
): Promise<{
  providers: {
    fetchProvider: WebFetchProvider | null;
    searchProvider: WebSearchProvider | null;
  };
  rewrite: RewrittenServerTools;
} | null> => {
  const declarations = findServerToolDeclarations(tools);

  if (!declarations) {
    return null;
  }

  // `declarations` is only non-null when `tools` is a non-empty array, so the
  // rewrite cannot decline.
  const toolList = tools as unknown[];

  const { fetchProvider, searchProvider } = await resolveServerToolBackends();

  return {
    providers: { fetchProvider, searchProvider },
    rewrite: rewriteServerTools({
      declarations,
      fetchProvider,
      searchProvider,
      tools: toolList,
    }),
  };
};

/**
 * Prose and reasoning a message carries, as the part of the turn that came
 * *before* the tool call it is attached to.
 */
const readPreamble = (
  message: ChatCompletionMessage | undefined,
): ServerToolPreamble => {
  if (!message) {
    return EMPTY_PREAMBLE;
  }

  return {
    reasoning: readReasoning(message).trim(),
    text: typeof message.content === 'string' ? message.content.trim() : '',
  };
};

/**
 * Rebuilds a response whose body has already been read.
 *
 * The turn reads the first upstream response to see whether the model asked for
 * a server tool, so the object handed back has to be reconstructed from those
 * bytes — a caller reading it a second time would otherwise hit "Body already
 * used".
 *
 * Framing headers are dropped: they describe the original body, which has since
 * been re-serialized to a different length. Keeping `content-length` truncates
 * the new one and keeping `content-encoding: gzip` makes a client try to
 * decompress plaintext.
 */
const rebuildResponse = (response: Response, body: string): Response => {
  const headers = new Headers(response.headers);

  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/**
 * Rewrites a payload so only the calls the client still has to answer survive.
 *
 * The executed ones have already been answered — their findings travel as
 * `executions`, which each renderer turns into real protocol blocks. Leaving
 * them in `tool_calls` too would hand the client a second, unresolved copy.
 */
const keepOutstandingCalls = (
  payload: ChatCompletionPayload,
  outstanding: ChatCompletionToolCall[],
): ChatCompletionPayload => {
  const [first, ...rest] = payload.choices ?? [];

  if (!first) {
    return payload;
  }

  return {
    ...payload,
    choices: [
      {
        ...first,
        // Only `tool_calls` when something really is outstanding: stamping it
        // onto an answer makes every renderer report `stop_reason: 'tool_use'`
        // with nothing to satisfy, and the client discards the answer.
        finish_reason: outstanding.length ? 'tool_calls' : 'stop',
        message: { ...(first.message ?? {}), tool_calls: outstanding },
      },
      ...rest,
    ],
  };
};

/**
 * Strips the proxy's own server-tool calls from a payload, whatever else it
 * carries.
 *
 * Used on the paths that return a payload the client will see without having
 * inspected it first — the failures above all. A `tool_use` for a `web_search`
 * the client never declared is a call it has no handler for, and the internal
 * function is not to be seen outside this turn; see the note in `classify.ts`.
 */
const keepClientCalls = (
  payload: ChatCompletionPayload,
  isExecutableCall: (toolCall: ChatCompletionToolCall) => boolean,
): ChatCompletionPayload =>
  keepOutstandingCalls(
    payload,
    (payload.choices?.[0]?.message?.tool_calls ?? []).filter(
      (toolCall) => !isExecutableCall(toolCall),
    ),
  );

/**
 * Reads a hop's payload, converting a malformed body into an error.
 *
 * A body that will not parse on a successful status is an upstream failure,
 * not a reason to throw out of the turn: everything already searched would be
 * billed and lost, and the client would get a JSON-parse message instead of
 * whatever upstream actually said.
 */
const readBufferedPayloadSafely = async (
  response: Response,
  buffered: string,
): Promise<ChatCompletionPayload> => {
  try {
    return await readBufferedChatCompletionPayload(
      rebuildResponse(response, buffered),
      buffered,
    );
  } catch {
    return { error: { message: 'Upstream returned a malformed response' } };
  }
};

/**
 * Drops a hop's prose and reasoning, which have already been captured as the
 * preamble. Leaving them on the payload too renders them twice — once ahead of
 * the searches, once after.
 */
const withoutContent = (
  payload: ChatCompletionPayload,
): ChatCompletionPayload => {
  const [first, ...rest] = payload.choices ?? [];

  if (!first) {
    return payload;
  }

  return {
    ...payload,
    choices: [
      {
        ...first,
        message: {
          ...(first.message ?? {}),
          content: null,
          reasoning: undefined,
          reasoning_content: undefined,
        },
      },
      ...rest,
    ],
  };
};

const asMessages = (body: ChatRequestBody): JsonRecord[] =>
  (Array.isArray(body.messages) ? body.messages : []) as JsonRecord[];

/**
 * Runs the server-tool loop; see the module note above.
 *
 * Every hop is buffered rather than streamed, because whether the model wants
 * another search is only knowable once the hop has finished. A streaming client
 * gets the finished turn replayed as SSE instead of a live stream — unavoidable
 * here, since the first search has to complete before there is anything to say.
 */
export const runServerToolTurn = async ({
  body,
  callUpstream,
  fetchProvider,
  onCall,
  onResult,
  rewrite,
  searchProvider,
}: {
  body: ChatRequestBody;
  /** One round trip to upstream. Always buffered. */
  callUpstream: (body: ChatRequestBody, stream: boolean) => Promise<Response>;
  fetchProvider: WebFetchProvider | null;
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
  /** Output of {@link rewriteServerTools} for this request. */
  rewrite: NonNullable<ReturnType<typeof rewriteServerTools>>;
  searchProvider: WebSearchProvider | null;
}): Promise<ServerToolTurnOutcome> => {
  const { classifyCall, executable, isExecutableCall, maxUses, tools } =
    rewrite;

  const executions: ServerToolExecution[] = [];
  // One entry per hop that ran something: the prose that preceded it, plus the
  // calls it made. Kept as a list because prose written between two searches
  // belongs between the two search blocks, and flattening it loses that.
  const segments: ServerToolSegment[] = [];
  /**
   * Only the messages this turn appended to the transcript it was handed.
   *
   * The turn builds its continuation internally, but a caller that drives
   * upstream across several rounds — the image-generation loop — replays the
   * request from its own copy of the messages. It has to be given these, or the
   * next round's model is asked to continue a turn whose searches it cannot
   * see: the findings were fed to the model once and then discarded.
   */
  const appended: JsonRecord[] = [];
  let transcript = asMessages(body);
  let usage: unknown = null;
  // Counted separately: the client declares `max_uses` on each server tool, so
  // a fetch must not spend the search budget — but both need a bound, or a
  // turn that only fetches would never terminate.
  let searches = 0;
  let fetches = 0;
  let callCounter = 0;
  let firstHop = true;

  while (true) {
    const response = await callUpstream(
      {
        ...body,
        messages: transcript,
        tools,
        // Only the first hop honours a forced server tool; after that the
        // model chooses, or it would never stop searching.
        //
        // Reconciled as well as relaxed: a declaration nothing here can run is
        // withdrawn from `tools`, so a choice still naming it would point at a
        // tool the request no longer offers — which some upstreams reject
        // outright. A pin naming one of the client's own tools is untouched.
        tool_choice: firstHop
          ? reconcileToolChoice(body.tool_choice, tools)
          : relaxToolChoice(body.tool_choice, classifyCall),
      },
      false,
    );

    const buffered = await response.text();
    const payload = await readBufferedPayloadSafely(response, buffered);
    usage = sumUsage(usage, payload.usage);

    // A failure ends the turn: the request did not succeed, and the client
    // needs the real status and detail rather than a summary.
    if (!response.ok || payload.error) {
      return {
        executions,
        followUpMessages: appended,
        segments,
        // Attached even on failure: the earlier hops really ran and were
        // really billed, and the Responses and image paths recover them from
        // the response rather than from the return value.
        response: attachServerToolExecutions(
          rebuildResponse(
            response,
            JSON.stringify(
              keepClientCalls(withUsage(payload, usage), isExecutableCall),
            ),
          ),
          executions,
          appended,
        ),
        usage,
      };
    }

    const message = payload.choices?.[0]?.message;
    const toolCalls: ChatCompletionToolCall[] = message?.tool_calls ?? [];
    // Each call is resolved to its kind once, here, rather than being
    // re-derived from its name further down.
    const localCalls = toolCalls.flatMap((toolCall) => {
      const kind = classifyCall(toolCall);

      return kind && isExecutableCall(toolCall) ? [{ kind, toolCall }] : [];
    });
    const remainingCalls = toolCalls.filter(
      (toolCall) => !isExecutableCall(toolCall),
    );

    // The model stopped asking. This hop is the answer.
    if (!localCalls.length) {
      return {
        executions,
        followUpMessages: appended,
        segments,
        response: attachServerToolExecutions(
          rebuildResponse(response, JSON.stringify(withUsage(payload, usage))),
          executions,
          appended,
        ),
        usage,
      };
    }

    // Captured on every hop, up to the first one that actually speaks: the
    // model may explain itself before each search, and only the closing
    // answer lives in the payload the renderer sees.

    // Clamped to the budget before executing: the bound is only testable
    // between hops, so a hop emitting k parallel searches would otherwise run
    // them all and overshoot by up to k-1 — billed to the client either way.
    const affordable = takeWithinBudget(localCalls, {
      fetches,
      maxUses,
      searches,
    });

    // A turn-scoped counter: indexing within a hop made two hops that omitted
    // ids both produce `server_tool_0`, so the transcript carried two calls
    // sharing one id.
    const invocations = affordable.map(({ kind, toolCall }) =>
      buildServerToolInvocation(toolCall, kind, callCounter++),
    );

    const results = await executeServerToolInvocations({
      fetchProvider,
      invocations,
      ...(onCall ? { onCall } : {}),
      ...(onResult ? { onResult } : {}),
      searchProvider,
    });

    executions.push(...results.map((result) => result.execution));
    segments.push({
      ...readPreamble(message),
      executions: results.map((result) => result.execution),
    });
    searches += results.filter(
      (result) => result.execution.type === 'web_search',
    ).length;
    fetches += results.filter(
      (result) => result.execution.type === 'web_fetch',
    ).length;

    // Only the calls that were actually run: an assistant message promising
    // more calls than there are results for violates the chat protocol, and
    // upstream rejects the next hop.
    const runCalls = invocations.map((invocation, index) => ({
      ...(affordable[index].toolCall as JsonRecord),
      id: invocation.id,
    }));

    if (runCalls.length) {
      const hopMessages: JsonRecord[] = [
        {
          ...(message as JsonRecord),
          content: message?.content ?? null,
          role: message?.role ?? 'assistant',
          tool_calls: runCalls,
        },
        ...results.map((result) => ({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        })),
      ];

      appended.push(...hopMessages);
      transcript = [...transcript, ...hopMessages];
    }

    /**
     * A hop that also asked for something the client owns cannot be continued
     * here: replaying the transcript would leave the client's own calls in an
     * assistant message with no result behind them, which upstream rejects.
     * The findings go back as they are and the outstanding calls stay the
     * client's to resolve — and every protocol this proxy serves can carry
     * those findings structurally, so nothing is folded into the text.
     */
    if (remainingCalls.length) {
      return {
        executions,
        followUpMessages: appended,
        segments,
        response: attachServerToolExecutions(
          rebuildResponse(
            response,
            JSON.stringify(
              withUsage(
                keepOutstandingCalls(withoutContent(payload), remainingCalls),
                usage,
              ),
            ),
          ),
          executions,
          appended,
        ),
        usage,
      };
    }

    firstHop = false;

    // Budget spent. One last call with the server tools withdrawn, so the
    // model answers with what it has instead of asking for a search it will
    // not get.
    // Only kind the turn can actually run counts, and a kind is spent only
    // when it has run out. OR-ing the two, or counting every declared kind,
    // would end the turn while one of them still had allowance left — or
    // never end it at all for a kind that was declared but never used.
    //
    // A hop that could afford nothing ends the turn for the same reason, and
    // it is not covered by the test above: when two kinds are runnable and the
    // model keeps asking only for the one that is exhausted, that test stays
    // false while the hop executes nothing — so the transcript never advances
    // and the loop would re-issue an identical request forever, each one a real
    // billed round trip.
    const spent =
      !affordable.length ||
      ((!executable.search || searches >= maxUses.web_search) &&
        (!executable.fetch || fetches >= maxUses.web_fetch));

    if (spent) {
      const finalResponse = await callUpstream(
        {
          ...body,
          messages: transcript,
          ...withoutServerTools(tools, isExecutableCall, body.tool_choice),
        },
        false,
      );

      const finalBuffered = await finalResponse.text();
      // Read safely, like every other hop: a closing call that answers with a
      // body that will not parse would otherwise throw out of the turn, and
      // every search already run would be billed and lost.
      const finalPayload = await readBufferedPayloadSafely(
        finalResponse,
        finalBuffered,
      );

      usage = sumUsage(usage, finalPayload.usage);

      if (!finalResponse.ok || finalPayload.error) {
        return {
          executions,
          followUpMessages: appended,
          segments,
          // Attached even on failure: the searches really ran and were really
          // billed, and the Responses path recovers them from the response.
          response: attachServerToolExecutions(
            rebuildResponse(
              finalResponse,
              JSON.stringify(
                keepClientCalls(
                  withUsage(finalPayload, usage),
                  isExecutableCall,
                ),
              ),
            ),
            executions,
            appended,
          ),
          usage,
        };
      }

      /**
       * The model may still ask, even with the tool withdrawn. Those calls are
       * dropped rather than passed on: the budget is spent, so nothing will
       * answer them, and the client never declared a `web_search` it could
       * resolve itself. Anything it *does* own survives.
       */
      return {
        executions,
        followUpMessages: appended,
        segments,
        response: attachServerToolExecutions(
          rebuildResponse(
            finalResponse,
            JSON.stringify(
              keepClientCalls(withUsage(finalPayload, usage), isExecutableCall),
            ),
          ),
          executions,
          appended,
        ),
        usage,
      };
    }
  }
};

/**
 * Trims a hop's calls to what the budget still allows.
 *
 * `searches`/`fetches` are the running totals and `maxUses` the bound for
 * each kind; a hop may ask for more than is left, and the excess is dropped
 * rather than executed and billed.
 */
const takeWithinBudget = <T extends { kind: ServerToolKind }>(
  calls: T[],
  budget: {
    fetches: number;
    maxUses: { web_fetch: number; web_search: number };
    searches: number;
  },
): T[] => {
  const left = {
    web_fetch: budget.maxUses.web_fetch - budget.fetches,
    web_search: budget.maxUses.web_search - budget.searches,
  };

  return calls.filter((call) => (left[call.kind] -= 1) >= 0);
};

/** Drops the server tools from a tool list, leaving the client's own. */
const withoutServerTools = (
  tools: unknown[],
  isExecutableCall: (toolCall: ChatCompletionToolCall) => boolean,
  toolChoice: unknown,
): { tool_choice: unknown; tools: unknown[] } => {
  const remaining = tools.filter((tool) => {
    const name = asRecord(asRecord(tool)?.function)?.name;

    return !isExecutableCall({
      function: { name: typeof name === 'string' ? name : '' },
    });
  });

  // No `tool_choice` once nothing is left to choose: naming a tool that is not
  // on offer is a contradiction some upstreams reject outright, and every
  // search already run lives in this hop's transcript.
  //
  // Reconciled rather than reset to `auto`, so a pin the client set on one of
  // its own tools survives the withdrawal — only one naming a withdrawn server
  // tool goes, and a client tool left unpinned still gets `auto`.
  return {
    tool_choice: remaining.length
      ? (reconcileToolChoice(toolChoice, remaining) ?? 'auto')
      : undefined,
    tools: remaining,
  };
};

/**
 * Writes the running total back onto a payload.
 *
 * Each hop reports only its own usage, and the client is billed for the whole
 * turn — every search plus the answer.
 */
const withUsage = (
  payload: ChatCompletionPayload,
  usage: unknown,
): ChatCompletionPayload =>
  usage === null || usage === undefined ? payload : { ...payload, usage };

/**
 * Stops a forced server tool from compelling another search.
 *
 * Claude Code's side request arrives with `tool_choice` pinned to
 * `web_search`, and that pin has to hold for the first hop — it is what makes
 * the model produce a query instead of answering from memory. Left in place it
 * would then force a search on every hop forever, so afterwards it becomes
 * `auto`: the model may search again, but it does not have to.
 *
 * `required` becomes `auto` for the same reason by another route.
 */
const relaxToolChoice = (
  toolChoice: unknown,
  classifyCall: (toolCall: ChatCompletionToolCall) => ServerToolKind | null,
): unknown => {
  if (!toolChoice) {
    return toolChoice;
  }

  const name = getForcedToolName(toolChoice);

  // Compared exactly, not by normalised prefix: `tool_choice` carries only a
  // name, and a client pinning its own `WebSearch` normalises to the same
  // string as the server tool — loosening that would quietly stop the model
  // from calling the tool the client pinned.
  if (name && classifyCall({ function: { name } }) !== null) {
    return 'auto';
  }

  if (toolChoice === 'required') {
    return 'auto';
  }

  return toolChoice;
};

/**
 * Folds the prose earlier hops produced into a payload that only carries the
 * last one.
 *
 * The image-generation loop replays a request with each generated image folded
 * back in, so only its final hop's message survives in the payload — but the
 * text the model wrote before each call is part of the turn, and dropping it
 * leaves the client's transcript out of step with what the model actually said.
 */
export const foldIntermediateTexts = (
  payload: ChatCompletionPayload,
  texts: string[],
): ChatCompletionPayload => {
  const extraText = texts.filter(Boolean).join('\n\n');
  const [first, ...rest] = payload.choices ?? [];

  if (!first || !extraText) {
    return payload;
  }

  const message = first.message ?? {};
  const existingText =
    typeof message.content === 'string' ? message.content : '';

  return {
    ...payload,
    choices: [
      {
        ...first,
        message: {
          ...message,
          content: [extraText, existingText].filter(Boolean).join('\n\n'),
        },
      },
      ...rest,
    ],
  };
};
