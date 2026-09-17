import {
  getActiveConfig,
  getCodeBuddyApiEndpoint,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../domain/config';
import {
  resolveFetchProvider,
  resolveSearchProvider,
  runWebFetchResult,
  runWebSearchResult,
} from '../search';
import { extractErrorMessage } from '../shared/http';

import type { ChatRequestBody } from './codebuddy';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  isMarkedServerTool,
  normalizeSearchBackend,
  normalizeToolName,
  stripServerToolMarker,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../search/tool';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebFetchResponse,
  WebSearchProvider,
  WebSearchResponse,
} from '../search/types';

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

const MAX_SEARCH_ITERATIONS = 5;
const STREAM_TEXT_CHUNK_LENGTH = 1024;

type JsonRecord = Record<string, unknown>;

export interface ChatCompletionToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

export interface ChatCompletionMessage {
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  role?: string;
  tool_calls?: ChatCompletionToolCall[];
}

export interface ChatCompletionPayload {
  choices?: Array<{
    finish_reason?: string | null;
    index?: number;
    message?: ChatCompletionMessage;
  }>;
  created?: number;
  /**
   * `status` is the upstream HTTP status, carried so a downstream mapper can
   * name the real error type instead of guessing it from the message text. It
   * is absent for a payload that already reported an error of its own.
   */
  error?: { message?: string; status?: number };
  id?: string;
  model?: string;
  object?: string;
  /**
   * One entry per server-tool hop, in the order the model produced them.
   *
   * Carries the grouping `message.content` / `reasoning_content` cannot: a
   * multi-hop turn joins every hop into one string per kind, which loses where
   * one hop's reasoning ends and the next begins. Absent when no hop ran, so
   * callers fall back to the OpenAI-shaped fields.
   */
  turns?: ServerToolTurn[];
  usage?: unknown;
}

/**
 * Rebuilds a failed upstream response so its body can be read again.
 *
 * A `Response` body can only be consumed once. The loop reads it to decide
 * whether the model asked for a server tool, and handing the same object back
 * used to leave the route layer — which reads it again to build the answer the
 * client actually sees — with a spent body: the second read threw
 * "Body already used" and the client got a 500 in place of the real upstream
 * status. Draining it here and replaying the bytes in a fresh response keeps
 * both reads working and preserves the body verbatim, so an upstream error
 * detail that is not valid JSON still reaches the client intact.
 *
 * `content-length` and `content-encoding` are dropped: the body is re-emitted
 * rather than re-encoded, and a stale length would describe bytes the upstream
 * compressed before this layer ever saw them.
 */
const buildServerToolFailureResponse = async (
  response: Response,
): Promise<Response> => {
  const headers = new Headers(response.headers);

  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');

  return new Response(await response.text(), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/**
 * Parses a buffered upstream body, tolerating a failure that is not JSON.
 *
 * A successful response must be well-formed — anything else is a bug worth
 * surfacing — but a failure status already tells the caller everything it
 * needs to know, and its body may legitimately be an HTML error page or a
 * bare string. Rejecting on those would turn an ordinary outage into an
 * unhandled rejection.
 */
const parseBufferedPayload = (
  buffered: string,
  ok: boolean,
): ChatCompletionPayload => {
  try {
    return JSON.parse(buffered) as ChatCompletionPayload;
  } catch (error) {
    if (ok) {
      throw error;
    }

    return {};
  }
};

const readBufferedChatCompletionPayload = async (
  response: Response,
): Promise<ChatCompletionPayload> => {
  // Cloned so the failure path can replay the body verbatim; see
  // {@link buildServerToolFailureResponse}.
  const buffered = await response.clone().text();
  const payload = parseBufferedPayload(buffered, response.ok);

  if (!response.ok || payload.error) {
    const ownMessage = payload.error?.message;
    // `extractErrorMessage` digs a nested message out of the payload, so
    // `{"error":{"message":"x"}}` reaches the client as "x" rather than as a
    // JSON string. The raw body is the fallback: a payload carrying only a
    // code has no message to find, and the JSON is still the only record of
    // what happened. An empty body says nothing, so it falls all the way
    // through to the generic message instead of winning on being non-null.
    const detail = buffered.trim();

    return {
      ...payload,
      error: {
        // The upstream's own explanation — a rate-limit code, a reset
        // timestamp — beats the proxy's generic "Upstream CodeBuddy request
        // failed", which says only that something failed and leaves the client
        // no way to tell what.
        //
        // `status` travels with the frame so a downstream mapper can name the
        // real error type instead of guessing it from the message text.
        message:
          extractErrorMessage(payload) ??
          ownMessage ??
          (detail || `Upstream request failed with status ${response.status}`),
        ...(response.ok ? {} : { status: response.status }),
      },
    };
  }

  return payload;
};

const asRecord = (value: unknown): JsonRecord | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
};

/**
 * Recognises one server-tool declaration.
 *
 * Anthropic sends dated server-tool *types* (`web_search_20260209`,
 * `web_fetch_20250910`), Responses sends `web_search_preview`, and a client may
 * also declare a plain function tool with the bare name for its own purposes.
 * All three shapes have to match, because the tool has to be swapped for a
 * function upstream can actually call regardless of how it arrived.
 *
 * Returns two independent answers. `matches` says the declaration is one this
 * proxy can serve; `serverDeclared` says it arrived as a provider-executed
 * server tool rather than as the client's own function. The difference decides
 * what happens when the tool cannot be executed: a server-tool declaration is
 * dropped, because upstream has no idea what to do with it, whereas the
 * client's own function is left exactly as sent — the client is the one that
 * resolves it, and deleting it would silently remove a capability the client
 * asked for.
 */
const classifyServerTool = (
  tool: unknown,
  name: string,
  prefix: string,
): { matches: boolean; serverDeclared: boolean } => {
  const record = asRecord(tool);

  if (!record) {
    return { matches: false, serverDeclared: false };
  }

  const type = typeof record.type === 'string' ? record.type : '';

  // A dedicated server-tool type (`web_search_20260209`, `web_fetch_20250910`,
  // `web_search_preview`) is unambiguous: only a provider-executed tool is
  // declared that way. The trailing date is part of the version, not the name,
  // so the prefix is matched in canonical form — `WebFetch_20250910` arrives
  // from upstream as readily as its snake_case spelling.
  if (normalizeToolName(type).startsWith(normalizeToolName(prefix))) {
    return { matches: true, serverDeclared: true };
  }

  const fn = asRecord(record.function);
  const isBareName =
    (typeof fn?.name === 'string' &&
      normalizeToolName(fn.name) === normalizeToolName(name)) ||
    (typeof record.name === 'string' &&
      normalizeToolName(record.name).startsWith(normalizeToolName(prefix)));

  // A Responses translation has already flattened the declaration into a plain
  // function, so the type is gone by now; its marker is the only surviving
  // evidence that the client asked for a provider-executed tool.
  return {
    matches: isBareName,
    serverDeclared: isBareName && isMarkedServerTool(tool),
  };
};

const isWebSearchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_TYPE_PREFIX)
    .matches;

const isWebFetchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_TYPE_PREFIX)
    .matches;

const isServerDeclaredSearchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

const isServerDeclaredFetchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

/**
 * Whether `toolCall` is a call the proxy is meant to execute.
 *
 * Matched in canonical form because the name comes back from the model, which
 * is under no obligation to repeat the spelling it was given: upstream echoes
 * `web_fetch` as `WebFetch` often enough to matter here. A miss is not a
 * fallback to the client — the call leaves the loop as an unanswered
 * client-owned tool, so the fetch silently never happens.
 */
const isWebSearchToolCall = (toolCall: ChatCompletionToolCall): boolean => {
  return (
    typeof toolCall.function?.name === 'string' &&
    normalizeToolName(toolCall.function.name) ===
      normalizeToolName(WEB_SEARCH_TOOL_NAME)
  );
};

const isWebFetchToolCall = (toolCall: ChatCompletionToolCall): boolean => {
  return (
    typeof toolCall.function?.name === 'string' &&
    normalizeToolName(toolCall.function.name) ===
      normalizeToolName(WEB_FETCH_TOOL_NAME)
  );
};

/**
 * Swaps locally executed server-tool declarations for functions upstream can
 * call. Passthrough tools keep their upstream representation.
 *
 * Returns `null` when no web tool is present. `executes` distinguishes a local
 * backend from passthrough: the latter still strips the internal provenance
 * marker, but never starts the server loop or buffers a stream.
 */
const replaceServerTools = ({
  fetchEnabled,
  fetchProvider,
  searchEnabled,
  searchPassthrough,
  searchProvider,
  tools,
}: {
  fetchEnabled: boolean;
  fetchProvider: WebFetchProvider | null;
  searchEnabled: boolean;
  searchPassthrough: boolean;
  searchProvider: WebSearchProvider | null;
  tools: unknown;
}): {
  executes: boolean;
  /** Canonical names the proxy took over, so call classification can tell its own calls from a client's. */
  ownedNames: Set<string>;
  tools: unknown[];
} | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  let matched = false;
  let executes = false;
  // Names the proxy is executing itself. A client may declare its own tool
  // under the same name, and the loop must not answer those calls: matching
  // the name is not enough to own it.
  const ownedNames = new Set<string>();

  const rewritten = tools.flatMap((tool): unknown[] => {
    if (isWebSearchTool(tool)) {
      if (searchEnabled && searchProvider) {
        matched = true;
        executes = true;
        ownedNames.add(normalizeToolName(WEB_SEARCH_TOOL_NAME));

        return [{ type: 'function', function: buildWebSearchToolDefinition() }];
      }

      if (!isServerDeclaredSearchTool(tool)) {
        return [tool];
      }

      matched = true;
      return searchPassthrough ? [stripServerToolMarker(tool)] : [];
    }

    if (isWebFetchTool(tool)) {
      // A client-owned function of the same name wins over the backend, exactly
      // as it does for search. The backend setting chooses who runs the *proxy's*
      // tool; it is not a licence to take over a tool the client declared and
      // resolves itself. Without this, a client that ships its own `web_fetch`
      // loses it the moment a deployment picks a backend.
      if (!isServerDeclaredFetchTool(tool)) {
        return [tool];
      }

      if (fetchEnabled && fetchProvider) {
        matched = true;
        executes = true;
        ownedNames.add(normalizeToolName(WEB_FETCH_TOOL_NAME));

        return [{ type: 'function', function: buildWebFetchToolDefinition() }];
      }

      matched = true;
      return [stripServerToolMarker(tool)];
    }

    // The marker is internal to this proxy, so it never reaches upstream.
    return [stripServerToolMarker(tool)];
  });

  return matched ? { executes, ownedNames, tools: rewritten } : null;
};

/**
 * Reads one string field out of a tool-call argument object.
 *
 * Backends expect a single string, but models emit `query`, `q`,
 * `search_query`, or an Anthropic-style `{query: {q: ...}}` nested object, so
 * any string-ish value is accepted rather than failing the call.
 */
const extractStringArgument = ({
  keys,
  rawArguments,
  required,
}: {
  keys: string[];
  rawArguments: string | undefined;
  required: boolean;
}): string => {
  if (!rawArguments) {
    return '';
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    // Some clients send a bare JSON string rather than an object.
    if (typeof parsed === 'string') {
      return parsed.trim();
    }

    const record = asRecord(parsed);

    if (!record) {
      return '';
    }

    for (const key of keys) {
      const value = record[key];

      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }

      // Anthropic-style arguments nest the value one level deeper.
      const nested = asRecord(value);

      if (nested) {
        for (const nestedKey of keys) {
          const nestedValue = nested[nestedKey];

          if (typeof nestedValue === 'string' && nestedValue.trim()) {
            return nestedValue.trim();
          }
        }
      }
    }

    if (required) {
      // Fall back to whichever field holds the first non-empty string, so an
      // unexpected argument shape still yields a usable value. Only safe when
      // every field means the same thing, which is true for a single-string
      // search query but not for a fetch's url plus prompt.
      const firstString = Object.values(record).find(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      );

      return firstString?.trim() ?? '';
    }

    return '';
  } catch {
    // Malformed JSON: treat the raw text as the value so the call still runs.
    return rawArguments.trim();
  }
};

const extractSearchQuery = (rawArguments: string | undefined): string =>
  extractStringArgument({
    keys: ['query', 'q', 'search_query', 'text'],
    rawArguments,
    required: true,
  });

/**
 * Builds the `web_fetch` arguments.
 *
 * A missing URL is reported to the model rather than thrown: the model sent the
 * call, so telling it the argument was missing lets it retry correctly, whereas
 * an exception would surface as an opaque tool failure.
 */
const extractFetchQuery = (rawArguments: string | undefined): WebFetchQuery => {
  const url = extractStringArgument({
    keys: ['url', 'uri', 'link'],
    rawArguments,
    required: false,
  });
  const prompt = extractStringArgument({
    keys: ['prompt', 'question', 'goal'],
    rawArguments,
    required: false,
  });

  return { ...(prompt ? { prompt } : {}), url };
};

const sumUsage = (accumulated: unknown, incoming: unknown): unknown => {
  const left = asRecord(accumulated);
  const right = asRecord(incoming);

  if (!left) {
    return incoming ?? null;
  }

  if (!right) {
    return accumulated;
  }

  const merged: JsonRecord = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const previous = left[key];

    if (typeof value === 'number' && typeof previous === 'number') {
      merged[key] = previous + value;
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
};

/**
 * Folds completed search results into the assistant text and re-emits the
 * outstanding tool calls unchanged, so a turn that mixed search with
 * client-side calls stays a valid transcript. The client sees its own calls
 * come back as if upstream had returned them directly.
 *
 * The findings are folded only when the route has no other way to carry them.
 * A route that renders them structurally passes
 * `findingsAsStructuredBlocks`, and the text is left alone: the results are
 * already on the wire as a result block, and a second copy in the prose is
 * what the user reads as the model reciting its own search output.
 */
const buildMixedTurnPayload = ({
  findingsAsStructuredBlocks = false,
  message,
  payload,
  remainingCalls,
  searchResults,
  usage,
}: {
  findingsAsStructuredBlocks?: boolean;
  message: ChatCompletionMessage | undefined;
  payload: ChatCompletionPayload;
  remainingCalls: ChatCompletionToolCall[];
  searchResults: string[];
  usage: unknown;
}): ChatCompletionPayload => {
  const existingText =
    typeof message?.content === 'string' && message.content.trim()
      ? message.content.trim()
      : '';
  const findings = findingsAsStructuredBlocks
    ? ''
    : searchResults.filter(Boolean).join('\n\n');
  const content = [existingText, findings].filter(Boolean).join('\n\n');

  return {
    ...payload,
    ...(usage ? { usage } : {}),
    choices: (payload.choices ?? []).map((choice, index) =>
      index === 0
        ? {
            ...choice,
            finish_reason: 'tool_calls',
            message: {
              ...(choice.message ?? {}),
              content: content || null,
              role: 'assistant',
              tool_calls: remainingCalls,
            },
          }
        : choice,
    ),
  };
};

export const readReasoning = (
  message: ChatCompletionMessage | undefined,
): string => {
  if (!message) {
    return '';
  }

  if (typeof message.reasoning_content === 'string') {
    return message.reasoning_content;
  }

  return typeof message.reasoning === 'string' ? message.reasoning : '';
};

/**
 * Pairs each hop's reasoning and text with the calls that hop made.
 *
 * The three arrays are index-aligned — entry N is hop N — so zipping them back
 * together is what restores the grouping a joined string cannot express. `texts`
 * and `reasonings` are one entry longer than `executions`, because the closing
 * hop answers instead of calling another tool.
 */
const buildIntermediateTurns = ({
  executions,
  reasonings,
  texts,
}: {
  executions: ServerToolExecution[][];
  reasonings: string[];
  texts: string[];
}): ServerToolTurn[] =>
  Array.from(
    { length: Math.max(reasonings.length, texts.length) },
    (_, index) => ({
      // Only `executions` can run short: the closing hop answers without
      // calling anything, so it has an entry in the prose arrays but none here.
      // The three arrays stay aligned because every hop appends to all of them.
      executions: executions[index] ?? [],
      reasoning: reasonings[index],
      text: texts[index],
    }),
  );

/**
 * Folds the text a multi-hop turn produced before its later server-tool calls
 * into the payload the client receives.
 *
 * Only the last iteration's message is in `payload`, but a turn that searched
 * more than once spoke before each search, and that text is part of the turn:
 * dropping it hides the model's reasoning from the user and leaves the
 * client's transcript out of step with what the model actually said.
 *
 * The same hops are also re-grouped into `turns`, because the folded strings
 * cannot express where one hop ends and the next begins.
 *
 * Shared with the image-generation loop, which has the same shape: a local
 * tool call is replayed with its result appended, so only the final hop's
 * message would otherwise survive.
 */
export const withIntermediateTurns = ({
  executions,
  payload,
  reasonings,
  texts,
}: {
  executions: ServerToolExecution[][];
  payload: ChatCompletionPayload;
  reasonings: string[];
  texts: string[];
}): ChatCompletionPayload => {
  const extraText = texts.filter(Boolean).join('\n\n');
  const extraReasoning = reasonings.filter(Boolean).join('\n\n');
  const [first, ...rest] = payload.choices ?? [];

  if (!first) {
    return payload;
  }

  const message = first.message ?? {};
  const existingText =
    typeof message.content === 'string' ? message.content : '';

  // Nothing from the earlier hops and nothing to fold in — but the hops may
  // still have run tools, which is exactly the case a caller consuming `turns`
  // needs: a hop that called a tool without speaking first is still a hop.
  if (!extraText && !extraReasoning && !executions.length) {
    return payload;
  }

  const content = [extraText, existingText].filter(Boolean).join('\n\n');
  const reasoning = [extraReasoning, readReasoning(message)]
    .filter(Boolean)
    .join('\n\n');

  return {
    ...payload,
    // Per-hop grouping for renderers that can express it. The joined strings
    // above stay as the OpenAI-shaped view; a client that builds Anthropic
    // content blocks needs to know where one hop's reasoning ends and the next
    // begins, which a joined string has already lost. The closing hop is the
    // model's final answer, so it carries no further calls.
    turns: buildIntermediateTurns({
      executions,
      reasonings: [...reasonings, readReasoning(message)],
      texts: [...texts, existingText],
    }),
    choices: [
      {
        ...first,
        message: {
          ...message,
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
      },
      ...rest,
    ],
  };
};

/**
 * Result of one server-tool pass.
 *
 * `response` is null when no tool could be executed: the request still has to
 * be sent, but with the server-tool declarations already stripped, so the
 * caller falls through to its ordinary upstream path.
 */
export interface ServerToolLoopResult {
  body: ChatRequestBody;
  executions: ServerToolExecution[];
  response: Response | null;
}

export type ServerToolInvocation =
  | {
      id: string;
      input: { query: string };
      type: 'web_search';
    }
  | {
      id: string;
      input: WebFetchQuery;
      type: 'web_fetch';
    };

export type ServerToolExecution =
  | (Extract<ServerToolInvocation, { type: 'web_search' }> & {
      result: WebSearchResponse;
    })
  | (Extract<ServerToolInvocation, { type: 'web_fetch' }> & {
      result: WebFetchResponse;
    });

/**
 * One server-tool hop as the model produced it.
 *
 * `reasoning` and `text` are what the model wrote before the calls in
 * `executions`; both are empty when it called tools without speaking first. The
 * last hop of a turn usually has no executions, because the model answered
 * instead of reaching for another tool.
 */
export interface ServerToolTurn {
  executions: ServerToolExecution[];
  reasoning: string;
  text: string;
}

export interface ServerToolCallbacks {
  emitStreamEvents?: boolean;
  /**
   * Set by routes that render a server tool's findings structurally —
   * Anthropic's `web_search_tool_result` block — instead of as prose. Those
   * routes must not also fold the same findings into the assistant text, or
   * the user sees the results twice: once as a result block and once as if
   * the model had written them.
   */
  findingsAsStructuredBlocks?: boolean;
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
}

const SERVER_TOOL_STREAM_EVENT_KEY = 'x-codebuddy2api-server-tool';

export type ServerToolStreamEvent =
  | { invocation: ServerToolInvocation; phase: 'call' }
  | { execution: ServerToolExecution; phase: 'result' };

export const getServerToolStreamEvent = (
  value: unknown,
): ServerToolStreamEvent | null => {
  const record = asRecord(value);
  const event = asRecord(record?.[SERVER_TOOL_STREAM_EVENT_KEY]);

  if (event?.phase === 'call' && event.invocation) {
    return {
      invocation: event.invocation as ServerToolInvocation,
      phase: 'call',
    };
  }

  if (event?.phase === 'result' && event.execution) {
    return {
      execution: event.execution as ServerToolExecution,
      phase: 'result',
    };
  }

  return null;
};

const serverToolExecutions = new WeakMap<Response, ServerToolExecution[]>();

export const attachServerToolExecutions = (
  response: Response,
  executions: ServerToolExecution[],
): Response => {
  if (executions.length) {
    serverToolExecutions.set(response, executions);
  }

  return response;
};

export const getServerToolExecutions = (
  response: Response,
): ServerToolExecution[] => serverToolExecutions.get(response) ?? [];

export type ServerToolUpstreamMode =
  'buffer' | 'detect-both' | 'detect-fetch' | 'detect-search' | 'stream';

const mergeStreamingToolName = (previous: string, incoming: string): string => {
  if (!previous || incoming.startsWith(previous)) return incoming;
  if (!incoming || previous.endsWith(incoming)) return previous;
  return previous + incoming;
};

const aggregateStreamingToolCalls = (
  deltas: ChatCompletionToolCall[],
): ChatCompletionToolCall[] => {
  const calls = new Map<
    string,
    ChatCompletionToolCall & {
      function: { arguments: string; name: string };
    }
  >();
  const latestKeyByIndex = new Map<number, string>();

  deltas.forEach((delta, position) => {
    const indexedKey =
      typeof delta.index === 'number'
        ? latestKeyByIndex.get(delta.index)
        : undefined;
    const key =
      indexedKey ??
      (delta.id ? `id:${delta.id}` : undefined) ??
      (typeof delta.index === 'number'
        ? `index:${delta.index}`
        : `position:${position}`);
    const current = calls.get(key) ?? {
      function: { arguments: '', name: '' },
      index: delta.index,
    };

    current.id = delta.id ?? current.id;
    current.index = delta.index ?? current.index;
    current.type = delta.type ?? current.type;
    current.function.arguments += delta.function?.arguments ?? '';
    current.function.name = mergeStreamingToolName(
      current.function.name,
      delta.function?.name ?? '',
    );
    calls.set(key, current);

    if (typeof delta.index === 'number') {
      latestKeyByIndex.set(delta.index, key);
    }
  });

  return [...calls.values()];
};

const buildServerToolInvocation = (
  toolCall: ChatCompletionToolCall,
  iteration: number,
  index: number,
): ServerToolInvocation =>
  isWebFetchToolCall(toolCall)
    ? {
        id: toolCall.id ?? `server_tool_${iteration}_${index}`,
        input: extractFetchQuery(toolCall.function?.arguments),
        type: 'web_fetch',
      }
    : {
        id: toolCall.id ?? `server_tool_${iteration}_${index}`,
        input: { query: extractSearchQuery(toolCall.function?.arguments) },
        type: 'web_search',
      };

const executeServerToolInvocations = async ({
  callbacks,
  fetchProvider,
  invocations,
  searchProvider,
}: {
  callbacks?: ServerToolCallbacks;
  fetchProvider: WebFetchProvider | null;
  invocations: ServerToolInvocation[];
  searchProvider: WebSearchProvider | null;
}): Promise<
  Array<{
    content: string;
    execution: ServerToolExecution;
    tool_call_id: string;
  }>
> => {
  invocations.forEach((invocation) => callbacks?.onCall?.(invocation));

  return await Promise.all(
    invocations.map(async (invocation) => {
      if (invocation.type === 'web_fetch') {
        const result = await runWebFetchResult({
          provider: fetchProvider,
          query: invocation.input,
        });
        const execution: ServerToolExecution = { ...invocation, result };
        callbacks?.onResult?.(execution);

        return {
          content: result.content,
          execution,
          tool_call_id: invocation.id,
        };
      }

      const result = await runWebSearchResult({
        provider: searchProvider,
        query: invocation.input.query,
      });
      const execution: ServerToolExecution = { ...invocation, result };
      callbacks?.onResult?.(execution);

      return {
        content: result.content,
        execution,
        tool_call_id: invocation.id,
      };
    }),
  );
};

/**
 * Result of streaming one upstream response while watching for server-tool
 * calls, so a follow-up iteration can decide what happened.
 *
 * `localCalls` and `remainingCalls` partition the aggregated tool calls the
 * way the execution loop needs them; `frames` are the frames that were held
 * back because they carried tool-call deltas.
 */
interface ServerToolProbe {
  content: string;
  frames: string[];
  localCalls: ChatCompletionToolCall[];
  reasoning: string;
  remainingCalls: ChatCompletionToolCall[];
  role: string;
  toolCalls: ChatCompletionToolCall[];
  usage: unknown;
}

/**
 * Whether the proxy is the one meant to answer this call.
 *
 * A call without an available backend is not a fallback to the client — it
 * leaves the loop as an unanswered client-owned tool — but it must not be
 * counted as locally executable either.
 */
const isLocalServerToolCall = ({
  fetchProvider,
  ownedNames,
  toolCall,
  searchProvider,
}: {
  fetchProvider: WebFetchProvider | null;
  /**
   * Canonical names the proxy took over. Without it a client's own tool that
   * happens to share a name — `web_fetch`, which is not a server tool in the
   * Responses API — gets executed by the loop instead of handed back.
   */
  ownedNames?: Set<string>;
  toolCall: ChatCompletionToolCall;
  searchProvider: WebSearchProvider | null;
}): boolean =>
  (Boolean(searchProvider) &&
    isWebSearchToolCall(toolCall) &&
    isOwned(ownedNames, WEB_SEARCH_TOOL_NAME)) ||
  (Boolean(fetchProvider) &&
    isWebFetchToolCall(toolCall) &&
    isOwned(ownedNames, WEB_FETCH_TOOL_NAME));

/**
 * Whether the proxy owns calls to `name`.
 *
 * `undefined` means the caller predates ownership tracking; those callers only
 * ever run the proxy's own declarations, so they are unaffected by client tools
 * of the same name.
 */
const isOwned = (ownedNames: Set<string> | undefined, name: string): boolean =>
  !ownedNames || ownedNames.has(normalizeToolName(name));

const probeServerToolStream = async ({
  canContinue,
  context,
  emitRaw,
  fetchProvider,
  onReader,
  ownedNames,
  response,
  searchProvider,
}: {
  canContinue: () => boolean;
  context: {
    responseCreated: number;
    responseId: string;
    responseModel: string;
    responseObject: string;
    role: string;
    usage: unknown;
  };
  emitRaw: (frame: string) => void;
  fetchProvider: WebFetchProvider | null;
  ownedNames?: Set<string>;
  /**
   * Hands the active reader to the caller's cancellation path. Without it a
   * disconnect cannot interrupt a read that is already parked: the loop only
   * notices the cancellation once upstream produces another chunk, which a
   * stalled upstream never does.
   */
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void;
  response: Response;
  searchProvider: WebSearchProvider | null;
}): Promise<ServerToolProbe> => {
  const frames: string[] = [];
  const toolCallDeltas: ChatCompletionToolCall[] = [];
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  onReader?.(reader);
  let buffer = '';
  let content = '';
  let reasoning = '';

  const inspectFrame = (frame: string): void => {
    const line = frame
      .split(/\r?\n/)
      .find((segment) => segment.startsWith('data:'));

    if (!line) {
      emitRaw(frame);
      return;
    }

    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') {
      frames.push(frame);
      return;
    }

    try {
      const chunk = JSON.parse(raw) as {
        choices?: Array<{
          delta?: ChatCompletionMessage & {
            tool_calls?: ChatCompletionToolCall[];
          };
          finish_reason?: string | null;
        }>;
        created?: number;
        id?: string;
        model?: string;
        object?: string;
        usage?: unknown;
      };
      context.responseId = chunk.id ?? context.responseId;
      context.responseModel = chunk.model ?? context.responseModel;
      context.responseObject =
        chunk.object?.replace(/\.chunk$/, '') ?? context.responseObject;
      context.responseCreated = chunk.created ?? context.responseCreated;
      context.usage = chunk.usage ?? context.usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      context.role = delta?.role ?? context.role;
      content += delta?.content ?? '';
      reasoning += delta?.reasoning_content ?? delta?.reasoning ?? '';

      // A tool-call frame is held rather than forwarded: if the turn turns out
      // to invoke a server tool, the call has to be answered locally instead
      // of being handed to the client as an unresolved call. Anything else the
      // delta carried — most importantly the text the model wrote before
      // deciding to search — still belongs to the visible turn, so it is
      // re-emitted without the tool call.
      if (delta?.tool_calls?.length) {
        toolCallDeltas.push(...delta.tool_calls);
        frames.push(frame);

        const visibleDelta = { ...delta };
        delete visibleDelta.tool_calls;

        if (Object.keys(visibleDelta).length) {
          const visible = JSON.stringify({
            ...chunk,
            choices: [{ ...choice, delta: visibleDelta, finish_reason: null }],
          });
          emitRaw(`data: ${visible}`);
        }
        return;
      }

      if (choice?.finish_reason === 'tool_calls') {
        frames.push(frame);
        return;
      }
    } catch {
      emitRaw(frame);
      return;
    }

    emitRaw(frame);
  };

  while (true) {
    const chunk = await reader.read();
    if (!canContinue()) break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const split = buffer.split(/\r?\n\r?\n/);
    buffer = split.pop() ?? '';
    split.forEach(inspectFrame);
  }

  if (buffer.trim()) inspectFrame(buffer);
  reader.releaseLock();
  onReader?.(null);

  const toolCalls = aggregateStreamingToolCalls(toolCallDeltas);
  const isLocalCall = (toolCall: ChatCompletionToolCall): boolean =>
    isLocalServerToolCall({
      fetchProvider,
      ownedNames,
      searchProvider,
      toolCall,
    });

  return {
    content,
    frames,
    localCalls: toolCalls.filter(isLocalCall),
    reasoning,
    remainingCalls: toolCalls.filter((toolCall) => !isLocalCall(toolCall)),
    role: context.role,
    toolCalls,
    usage: context.usage,
  };
};

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
    return { body, executions: [], response: firstResponse };
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
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
    return { body: { ...body, tools }, executions: [], response: null };
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
      return { body: loopBody, executions, response };
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

    const invocations = localCalls.map(
      (toolCall, index): ServerToolInvocation =>
        isWebFetchToolCall(toolCall)
          ? {
              id: toolCall.id ?? `server_tool_${iteration}_${index}`,
              input: extractFetchQuery(toolCall.function?.arguments),
              type: 'web_fetch',
            }
          : {
              id: toolCall.id ?? `server_tool_${iteration}_${index}`,
              input: {
                query: extractSearchQuery(toolCall.function?.arguments),
              },
              type: 'web_search',
            },
    );
    invocations.forEach((invocation) => callbacks?.onCall?.(invocation));

    const results = await Promise.all(
      invocations.map(async (invocation) => {
        if (invocation.type === 'web_fetch') {
          const result = await runWebFetchResult({
            provider: fetchProvider,
            query: invocation.input,
          });
          const execution: ServerToolExecution = { ...invocation, result };
          callbacks?.onResult?.(execution);

          return {
            content: result.content,
            execution,
            tool_call_id: invocation.id,
          };
        }

        const result = await runWebSearchResult({
          provider: searchProvider,
          query: invocation.input.query,
        });
        const execution: ServerToolExecution = { ...invocation, result };
        callbacks?.onResult?.(execution);

        return {
          content: result.content,
          execution,
          tool_call_id: invocation.id,
        };
      }),
    );
    executions.push(...results.map((result) => result.execution));

    // A turn mixing server tools with client-side calls cannot be continued
    // locally: the client owns those calls, and re-issuing the transcript with
    // only server-tool results would leave them unanswered, which upstream
    // rejects as an invalid tool-call transcript. Run the server tools and
    // hand the outstanding calls back so the client resolves them on its next
    // turn. The findings ride along in the message text only for routes that
    // cannot render them structurally; see `buildMixedTurnPayload`.
    if (remainingCalls.length) {
      return {
        body: loopBody,
        executions,
        response: Response.json(
          buildMixedTurnPayload({
            findingsAsStructuredBlocks: callbacks?.findingsAsStructuredBlocks,
            // `buildMixedTurnPayload` reads this iteration's text and reasoning
            // off `message`, so only the earlier iterations go on top; the
            // current one is folded in by the helper itself.
            message: withIntermediateTurns({
              payload,
              executions: intermediateExecutions,
              reasonings: intermediateReasonings,
              texts: intermediateTexts,
            }).choices?.[0]?.message,
            payload,
            remainingCalls,
            searchResults: results.map((result) => result.content),
            usage,
          }),
          { status: response.status },
        ),
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
      };
    }

    return {
      body: loopBody,
      executions,
      response: Response.json(
        {
          ...withIntermediateTurns({
            payload,
            executions: intermediateExecutions,
            reasonings: intermediateReasonings,
            texts: intermediateTexts,
          }),
          ...(usage ? { usage } : {}),
        },
        { status: finalResponse.status },
      ),
    };
  }

  return {
    body: loopBody,
    executions,
    response: Response.json(
      {
        ...withIntermediateTurns({
          payload,
          executions: intermediateExecutions,
          reasonings: intermediateReasonings,
          texts: intermediateTexts,
        }),
        ...(usage ? { usage } : {}),
      },
      { status: response!.status },
    ),
  };
};

/**
 * Replays a buffered completion as chat-completion SSE. Used only after a
 * streaming request actually invokes a server-executed tool; ordinary answers
 * keep the upstream response untouched.
 */
export const synthesizeChatCompletionStream = (
  payload: ChatCompletionPayload,
  fallbackModel: string,
): Response => {
  const encoder = new TextEncoder();
  const choice = payload.choices?.[0];
  const message = choice?.message;
  const created =
    typeof payload.created === 'number'
      ? payload.created
      : Math.floor(Date.now() / 1000);
  const model =
    typeof payload.model === 'string' && payload.model
      ? payload.model
      : fallbackModel;
  const id =
    typeof payload.id === 'string' && payload.id
      ? payload.id
      : `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`;

  const enqueue = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: JsonRecord,
  ): void => {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          ...chunk,
          created,
          id,
          model,
          object: 'chat.completion.chunk',
        })}\n\n`,
      ),
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      enqueue(controller, {
        choices: [{ delta: { role: 'assistant' }, index: 0 }],
      });

      const reasoning = message?.reasoning_content ?? message?.reasoning;

      if (reasoning) {
        enqueue(controller, {
          choices: [{ delta: { reasoning_content: reasoning }, index: 0 }],
        });
      }

      const content =
        typeof message?.content === 'string' ? message.content : '';

      for (
        let offset = 0;
        offset < content.length;
        offset += STREAM_TEXT_CHUNK_LENGTH
      ) {
        enqueue(controller, {
          choices: [
            {
              delta: {
                content: content.slice(
                  offset,
                  offset + STREAM_TEXT_CHUNK_LENGTH,
                ),
              },
              index: 0,
            },
          ],
        });
      }

      const passthroughCalls = (message?.tool_calls ?? []).map(
        (toolCall, index) => ({
          ...toolCall,
          id: toolCall.id ?? `call_${index}`,
          index,
          type: toolCall.type ?? 'function',
        }),
      );

      if (passthroughCalls.length) {
        enqueue(controller, {
          choices: [{ delta: { tool_calls: passthroughCalls }, index: 0 }],
        });
      }

      enqueue(controller, {
        choices: [
          {
            delta: {},
            finish_reason:
              choice?.finish_reason ??
              (passthroughCalls.length ? 'tool_calls' : 'stop'),
            index: 0,
          },
        ],
      });

      if (payload.usage !== undefined && payload.usage !== null) {
        enqueue(controller, {
          choices: [],
          usage: payload.usage,
        });
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};
