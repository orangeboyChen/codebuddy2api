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

import type { ChatRequestBody } from './codebuddy';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  isMarkedServerTool,
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

interface ChatCompletionToolCall {
  id?: string;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

interface ChatCompletionMessage {
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
  error?: { message?: string };
  id?: string;
  model?: string;
  object?: string;
  usage?: unknown;
}

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
 * Whether `tool` is a provider-executed server-tool declaration.
 *
 * Used to strip declarations upstream would not understand. A plain function
 * tool the client named `web_search` or `web_fetch` is excluded: the client
 * resolves it itself, so removing it would take away a working capability.
 */
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
}): { executes: boolean; tools: unknown[] } | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  let matched = false;
  let executes = false;

  const rewritten = tools.flatMap((tool): unknown[] => {
    if (isWebSearchTool(tool)) {
      if (searchEnabled && searchProvider) {
        matched = true;
        executes = true;

        return [{ type: 'function', function: buildWebSearchToolDefinition() }];
      }

      if (!isServerDeclaredSearchTool(tool)) {
        return [tool];
      }

      matched = true;
      return searchPassthrough ? [stripServerToolMarker(tool)] : [];
    }

    if (isWebFetchTool(tool)) {
      if (fetchEnabled && fetchProvider) {
        matched = true;
        executes = true;

        return [{ type: 'function', function: buildWebFetchToolDefinition() }];
      }

      if (!isServerDeclaredFetchTool(tool)) {
        return [tool];
      }

      matched = true;
      return [stripServerToolMarker(tool)];
    }

    // The marker is internal to this proxy, so it never reaches upstream.
    return [stripServerToolMarker(tool)];
  });

  return matched ? { executes, tools: rewritten } : null;
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
 */
const buildMixedTurnPayload = ({
  message,
  payload,
  remainingCalls,
  searchResults,
  usage,
}: {
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
  const findings = searchResults.filter(Boolean).join('\n\n');
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

export interface ServerToolCallbacks {
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
}

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
  'buffer' | 'detect-both' | 'detect-fetch' | 'detect-search';

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
    searchPassthrough: config.CODEBUDDY_WEB_SEARCH_BACKEND === 'passthrough',
    searchProvider,
    tools: body.tools,
  });

  if (!replacement) {
    return null;
  }

  const { executes, tools } = replacement;

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
  const initialMode: ServerToolUpstreamMode =
    searchProvider && fetchProvider
      ? 'detect-both'
      : searchProvider
        ? 'detect-search'
        : 'detect-fetch';

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

    payload = (await response.json()) as ChatCompletionPayload;

    if (!response.ok || payload.error) {
      return { body: loopBody, executions, response };
    }

    usage = sumUsage(usage, payload.usage);

    const message = payload.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    const localCalls = toolCalls.filter(
      (toolCall) =>
        (Boolean(searchProvider) && isWebSearchToolCall(toolCall)) ||
        (Boolean(fetchProvider) && isWebFetchToolCall(toolCall)),
    );
    const remainingCalls = toolCalls.filter(
      (toolCall) =>
        (!searchProvider || !isWebSearchToolCall(toolCall)) &&
        (!fetchProvider || !isWebFetchToolCall(toolCall)),
    );

    if (!localCalls.length) {
      break;
    }

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
    // rejects as an invalid tool-call transcript. Run the server tools, fold the
    // findings into the message text, and hand the outstanding calls back so the
    // client resolves them on its next turn.
    if (remainingCalls.length) {
      return {
        body: loopBody,
        executions,
        response: Response.json(
          buildMixedTurnPayload({
            message,
            payload,
            remainingCalls,
            searchResults: results.map((result) => result.content),
            usage,
          }),
          { status: response.status },
        ),
      };
    }

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
    payload = (await finalResponse.json()) as ChatCompletionPayload;
    usage = sumUsage(usage, payload.usage);

    if (!finalResponse.ok || payload.error) {
      return { body: loopBody, executions, response: finalResponse };
    }

    return {
      body: loopBody,
      executions,
      response: Response.json(
        { ...payload, ...(usage ? { usage } : {}) },
        { status: finalResponse.status },
      ),
    };
  }

  return {
    body: loopBody,
    executions,
    response: Response.json(
      { ...payload, ...(usage ? { usage } : {}) },
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
