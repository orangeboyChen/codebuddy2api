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
  ServerToolPreamble,
  ServerToolTurnOutcome,
} from './types';
import { attachServerToolExecutions, EMPTY_PREAMBLE } from './types';

/**
 * One server-tool turn.
 *
 * The model is asked for a search, the search runs here, and upstream is asked
 * once more — without the server tools it could call again — to write the
 * answer. Two calls at most, and the second is unconditional, which is why this
 * is not a loop: there is no "until the model stops asking", because the
 * follow-up cannot ask.
 *
 * A client that wants several searches sends several requests. Claude Code is
 * the reference: it resolves its own `WebSearch` tool, and only opens a
 * sub-request carrying the server type once it has a result to fill in. That
 * sub-request asks for exactly one search, and this answers it.
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
  rewrite: NonNullable<ReturnType<typeof rewriteServerTools>>;
} | null> => {
  const declarations = findServerToolDeclarations(tools);

  if (!declarations) {
    return null;
  }

  const { fetchProvider, searchProvider } = await resolveServerToolBackends();
  const rewrite = rewriteServerTools({
    declarations,
    fetchProvider,
    searchProvider,
    tools,
  });

  if (!rewrite) {
    return null;
  }

  return { providers: { fetchProvider, searchProvider }, rewrite };
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

const asMessages = (body: ChatRequestBody): JsonRecord[] =>
  (Array.isArray(body.messages) ? body.messages : []) as JsonRecord[];

/**
 * Runs one server-tool turn.
 *
 * Upstream is asked for a search, the search runs here, and upstream is asked
 * once more — without the server tools, so it cannot ask again — to write the
 * answer. Two calls at most. The response is always the one to render: the
 * first has already been spent reading the tool calls, so a caller that
 * re-issued it would be billed twice for the same turn.
 */
export const runServerToolTurn = async ({
  body,
  callUpstream,
  fetchProvider,
  onCall,
  onResult,
  rewrite,
  searchProvider,
  stream,
}: {
  body: ChatRequestBody;
  /**
   * One round trip to upstream. `stream` asks for SSE rather than a buffered
   * payload; the first call is always buffered, because the tool calls are only
   * visible once it has finished.
   */
  callUpstream: (body: ChatRequestBody, stream: boolean) => Promise<Response>;
  fetchProvider: WebFetchProvider | null;
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
  /** Output of {@link rewriteServerTools} for this request. */
  rewrite: NonNullable<ReturnType<typeof rewriteServerTools>>;
  searchProvider: WebSearchProvider | null;
  stream: boolean;
}): Promise<ServerToolTurnOutcome> => {
  const { executable, followUpTools, isExecutableCall, tools } = rewrite;

  const first = await callUpstream({ ...body, tools }, false);
  const buffered = await first.text();
  const payload = await readBufferedChatCompletionPayload(
    rebuildResponse(first, buffered),
    buffered,
  );

  // A failure is handed back untouched: whatever the turn would have done with
  // the tool calls, the request did not succeed, and the client needs the real
  // status and detail rather than a summary.
  if (!first.ok || payload.error) {
    return {
      executions: [],
      preamble: EMPTY_PREAMBLE,
      response: rebuildResponse(first, buffered),
    };
  }

  const message = payload.choices?.[0]?.message;
  const toolCalls: ChatCompletionToolCall[] = message?.tool_calls ?? [];
  const localCalls = toolCalls.filter(isExecutableCall);

  // The model answered without reaching for a server tool — the ordinary case
  // for a request that merely *declares* one. Its answer is the whole turn, so
  // the caller renders this response directly.
  if (!localCalls.length) {
    return {
      executions: [],
      preamble: readPreamble(message),
      response: rebuildResponse(first, buffered),
    };
  }

  const invocations = localCalls.map((toolCall, index) =>
    buildServerToolInvocation(toolCall, index),
  );

  const results = await executeServerToolInvocations({
    fetchProvider,
    invocations,
    ...(onCall ? { onCall } : {}),
    ...(onResult ? { onResult } : {}),
    searchProvider,
  });

  const executions: ServerToolExecution[] = results.map(
    (result) => result.execution,
  );

  const messages: JsonRecord[] = [
    ...asMessages(body),
    {
      ...(message as JsonRecord),
      content: message?.content ?? null,
      role: message?.role ?? 'assistant',
    },
    ...results.map((result) => ({
      role: 'tool',
      content: result.content,
      tool_call_id: result.tool_call_id,
    })),
  ];

  const response = await callUpstream(
    {
      ...body,
      messages,
      tools: followUpTools,
      tool_choice: relaxToolChoice(body.tool_choice, executable),
    },
    stream,
  );

  return {
    // Published on the response as well as returned, so a caller that drives
    // upstream itself — the image-generation loop — can pick up searches that
    // ran on a hop it did not produce.
    executions,
    preamble: readPreamble(message),
    response: attachServerToolExecutions(response, executions),
  };
};

/**
 * Keeps the follow-up from being forced back into a search.
 *
 * A `tool_choice` naming a server tool the proxy has just run would make the
 * follow-up call it again — and the follow-up has no server tool to call, so
 * upstream would reject it. `required` has the same effect by another route: it
 * obliges the model to call something when the turn needs an answer.
 */
const relaxToolChoice = (
  toolChoice: unknown,
  executable: { fetch: boolean; search: boolean },
): unknown => {
  if (!toolChoice) {
    return toolChoice;
  }

  const name = getForcedToolName(toolChoice);
  const canonical = name ? name.toLowerCase().replace(/[_\-\s]+/g, '') : '';

  if (
    canonical &&
    ((executable.search && canonical.startsWith('websearch')) ||
      (executable.fetch && canonical.startsWith('webfetch')))
  ) {
    return 'none';
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

/** Reads the payload of a buffered upstream response. */
export const readJsonResponse = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  const text = await response.text();

  try {
    return asRecord(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
};

export type { ChatCompletionMessage };
