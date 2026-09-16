import {
  getActiveConfig,
  getCodeBuddyApiEndpoint,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../domain/config';
import {
  resolveFetchProvider,
  resolveSearchProvider,
  runWebFetch,
  runWebSearch,
} from '../search';

import type { ChatRequestBody } from './codebuddy';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  isMarkedServerTool,
  stripServerToolMarker,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../search/tool';
import type {
  WebFetchProvider,
  WebFetchQuery,
  WebSearchProvider,
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
 * The loop has to buffer: a tool call is only complete once the upstream
 * response ends, so a streaming client is served a synthesized stream after
 * the final iteration rather than a pass-through of upstream bytes.
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
  // declared that way.
  if (type.startsWith(prefix)) {
    return { matches: true, serverDeclared: true };
  }

  const fn = asRecord(record.function);
  const isBareName =
    (typeof fn?.name === 'string' && fn.name === name) ||
    (typeof record.name === 'string' && record.name.startsWith(prefix));

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

/**
 * Whether `tool` is a provider-executed server-tool declaration.
 *
 * Used to strip declarations upstream would not understand. A plain function
 * tool the client named `web_search` or `web_fetch` is excluded: the client
 * resolves it itself, so removing it would take away a working capability.
 */
const isServerDeclaredSearchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

const isServerDeclaredFetchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

const isWebSearchToolCall = (toolCall: ChatCompletionToolCall): boolean => {
  return toolCall.function?.name === WEB_SEARCH_TOOL_NAME;
};

const isWebFetchToolCall = (toolCall: ChatCompletionToolCall): boolean => {
  return toolCall.function?.name === WEB_FETCH_TOOL_NAME;
};

/**
 * Swaps every supported server-tool declaration for the function tool upstream
 * can actually call, dropping any that cannot be executed.
 *
 * Returns `null` when nothing was swapped, so callers can skip the loop
 * entirely and keep the fast pass-through path.
 *
 * A server-tool declaration that cannot be executed is dropped rather than
 * passed through: advertising a tool that would be refused is worse than not
 * advertising it, since the model calls it and the turn is wasted.
 *
 * Whether a tool is taken over depends on the backend, not on how it was
 * declared — with a working backend the proxy runs it regardless of shape.
 * Provenance matters only when nothing can execute it, which is where a
 * client-owned function has to be preserved; see `classifyServerTool`.
 */
const replaceServerTools = ({
  fetchEnabled,
  fetchProvider,
  searchEnabled,
  searchProvider,
  tools,
}: {
  fetchEnabled: boolean;
  fetchProvider: WebFetchProvider | null;
  searchEnabled: boolean;
  searchProvider: WebSearchProvider | null;
  tools: unknown;
}): unknown[] | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  let changed = false;

  const rewritten = tools.flatMap((tool): unknown[] => {
    if (isWebSearchTool(tool)) {
      if (searchEnabled && searchProvider) {
        changed = true;

        return [{ type: 'function', function: buildWebSearchToolDefinition() }];
      }

      // Cannot execute it: drop the declaration if upstream would not
      // recognise it, otherwise leave the client's own tool untouched.
      return isServerDeclaredSearchTool(tool) ? ((changed = true), []) : [tool];
    }

    if (isWebFetchTool(tool)) {
      // A backend that can execute the tool takes it over, whatever shape the
      // declaration arrived in — that is the point of the setting.
      if (fetchEnabled && fetchProvider) {
        changed = true;

        return [{ type: 'function', function: buildWebFetchToolDefinition() }];
      }

      // With no backend, provenance decides: a provider-executed declaration is
      // dropped, while a client-owned function is left for the client to run.
      return isServerDeclaredFetchTool(tool) ? ((changed = true), []) : [tool];
    }

    // The marker is internal to this proxy, so it never reaches upstream.
    return [stripServerToolMarker(tool)];
  });

  // Tracking `changed` explicitly rather than comparing lengths: swapping one
  // declaration for one definition leaves the count identical, so a length
  // check would silently skip the loop for the common single-tool request.
  return changed ? rewritten : null;
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
  response: Response | null;
}

export const executeWebSearchLoop = async ({
  body,
  callUpstream,
}: {
  body: ChatRequestBody;
  callUpstream: (body: ChatRequestBody) => Promise<Response>;
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

  // Runs even when both tools are switched off. Typed server-tool declarations
  // (`web_search_preview`, `web_fetch_20250910`) are meaningless to upstream, so
  // they have to be stripped on the way out regardless of whether the proxy
  // intends to execute them — otherwise the default configuration forwards a
  // declaration upstream rejects, or hands back a tool nobody implements.
  const tools = replaceServerTools({
    fetchEnabled,
    fetchProvider,
    searchEnabled,
    searchProvider,
    tools: body.tools,
  });

  if (!tools) {
    return null;
  }

  // Nothing can be executed, so there is nothing to loop for. The rewritten
  // `tools` still have to reach the caller: it forwards them upstream, and the
  // stripped declarations have to stay stripped on that path too.
  if (!searchProvider && !fetchProvider) {
    return { body: { ...body, tools }, response: null };
  }

  const messages: JsonRecord[] = body.messages as JsonRecord[];
  let loopBody: ChatRequestBody = { ...body, messages, tools };
  let response: Response | null = null;
  let payload: ChatCompletionPayload | null = null;
  let usage: unknown = null;

  for (let iteration = 0; iteration < MAX_SEARCH_ITERATIONS; iteration++) {
    response = await callUpstream(loopBody);
    payload = (await response.json()) as ChatCompletionPayload;

    if (!response.ok || payload.error) {
      return { body: loopBody, response };
    }

    usage = sumUsage(usage, payload.usage);

    const message = payload.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    const localCalls = toolCalls.filter(
      (toolCall) =>
        isWebSearchToolCall(toolCall) || isWebFetchToolCall(toolCall),
    );
    const remainingCalls = toolCalls.filter(
      (toolCall) =>
        !isWebSearchToolCall(toolCall) && !isWebFetchToolCall(toolCall),
    );

    if (!localCalls.length) {
      break;
    }

    const results = await Promise.all(
      localCalls.map(async (toolCall) => ({
        content: isWebFetchToolCall(toolCall)
          ? await runWebFetch({
              // Already resolved above; re-resolving would rebuild the provider
              // for every call in the turn.
              provider: fetchProvider,
              query: extractFetchQuery(toolCall.function?.arguments),
            })
          : await runWebSearch({
              provider: searchProvider,
              query: extractSearchQuery(toolCall.function?.arguments),
            }),
        tool_call_id: toolCall.id ?? '',
      })),
    );

    // A turn mixing server tools with client-side calls cannot be continued
    // locally: the client owns those calls, and re-issuing the transcript with
    // only server-tool results would leave them unanswered, which upstream
    // rejects as an invalid tool-call transcript. Run the server tools, fold the
    // findings into the message text, and hand the outstanding calls back so the
    // client resolves them on its next turn.
    if (remainingCalls.length) {
      return {
        body: loopBody,
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
    const finalResponse = await callUpstream({
      ...loopBody,
      tools: (loopBody.tools ?? []).filter(
        (tool) => !isWebSearchTool(tool) && !isWebFetchTool(tool),
      ),
    });
    payload = (await finalResponse.json()) as ChatCompletionPayload;
    usage = sumUsage(usage, payload.usage);

    if (!finalResponse.ok || payload.error) {
      return { body: loopBody, response: finalResponse };
    }

    return {
      body: loopBody,
      response: Response.json(
        { ...payload, ...(usage ? { usage } : {}) },
        { status: finalResponse.status },
      ),
    };
  }

  return {
    body: loopBody,
    response: Response.json(
      { ...payload, ...(usage ? { usage } : {}) },
      { status: response?.status ?? 200 },
    ),
  };
};

/**
 * Replays a buffered completion as chat-completion SSE. Used only for
 * streaming clients whose request ran the search loop; every other request
 * keeps the upstream response untouched.
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
