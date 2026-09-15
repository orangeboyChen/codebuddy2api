import { isWebSearchEnabled } from '../domain/config';
import { runWebSearch } from '../search';

import type { ChatRequestBody } from './codebuddy';
import {
  buildWebSearchToolDefinition,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../search/tool';

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
 * Anthropic sends server-tool types (`web_search_20260209`) and Responses
 * sends `web_search_preview`; both must be recognised, along with a plain
 * function tool a client may name `web_search` for its own purposes.
 */
const isWebSearchTool = (tool: unknown): boolean => {
  const record = asRecord(tool);

  if (!record) {
    return false;
  }

  const type = typeof record.type === 'string' ? record.type : '';
  if (type.startsWith(WEB_SEARCH_TOOL_TYPE_PREFIX)) {
    return true;
  }

  const fn = asRecord(record.function);
  const name = typeof fn?.name === 'string' ? fn.name : '';

  return (
    name === WEB_SEARCH_TOOL_NAME ||
    (typeof record.name === 'string' &&
      record.name.startsWith(WEB_SEARCH_TOOL_TYPE_PREFIX))
  );
};

const isWebSearchToolCall = (toolCall: ChatCompletionToolCall): boolean => {
  return toolCall.function?.name === WEB_SEARCH_TOOL_NAME;
};

/**
 * Swaps every web search declaration for the one function tool upstream can
 * actually call. Returns `null` when the request declares no search tool, so
 * callers can skip the loop entirely and keep the fast pass-through path.
 */
const replaceWebSearchTools = (tools: unknown): unknown[] | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  if (!tools.some(isWebSearchTool)) {
    return null;
  }

  const definition = buildWebSearchToolDefinition();

  return tools.map((tool) =>
    isWebSearchTool(tool) ? { type: 'function', function: definition } : tool,
  );
};

/**
 * SearXNG expects one query string. Clients send `{query}`, but models also
 * emit `q`, `search_query`, or an Anthropic-style `{query: {q: ...}}` object,
 * so any string-ish value is accepted rather than failing the call.
 */
const extractSearchQuery = (rawArguments: string | undefined): string => {
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

    for (const key of ['query', 'q', 'search_query', 'text']) {
      const value = record[key];

      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }

      // Anthropic-style arguments nest the query one level deeper.
      const nested = asRecord(value);

      if (nested && typeof nested.q === 'string' && nested.q.trim()) {
        return nested.q.trim();
      }
    }

    // Fall back to whichever field holds the first non-empty string, so an
    // unexpected argument shape still yields a usable query.
    const firstString = Object.values(record).find(
      (value): value is string =>
        typeof value === 'string' && value.trim().length > 0,
    );

    return firstString?.trim() ?? '';
  } catch {
    // Malformed JSON: treat the raw text as the query so the search still runs.
    return rawArguments.trim();
  }
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

export const executeWebSearchLoop = async ({
  body,
  callUpstream,
}: {
  body: ChatRequestBody;
  callUpstream: (body: ChatRequestBody) => Promise<Response>;
}): Promise<{ body: ChatRequestBody; response: Response } | null> => {
  const tools = replaceWebSearchTools(body.tools);

  if (!tools || !(await isWebSearchEnabled())) {
    return null;
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
    const searchCalls = toolCalls.filter(isWebSearchToolCall);
    const remainingCalls = toolCalls.filter(
      (toolCall) => !isWebSearchToolCall(toolCall),
    );

    if (!searchCalls.length) {
      break;
    }

    const results = await Promise.all(
      searchCalls.map(async (toolCall) => ({
        content: await runWebSearch({
          query: extractSearchQuery(toolCall.function?.arguments),
        }),
        tool_call_id: toolCall.id ?? '',
      })),
    );

    // A turn mixing search with client-side calls cannot be continued locally:
    // the client owns those calls, and re-issuing the transcript with only
    // search results would leave them unanswered, which upstream rejects as an
    // invalid tool-call transcript. Run the searches, fold the findings into the
    // message text, and hand the outstanding calls back so the client resolves
    // them on its next turn.
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

    // A forced tool_choice would make the model call search forever; once the
    // loop is running, let it decide when it has enough.
    loopBody = {
      ...loopBody,
      messages,
      tool_choice: loopBody.tool_choice ? 'auto' : loopBody.tool_choice,
    };
    payload = null;
  }

  // The budget ran out with the model still asking to search. Drop the search
  // tool and ask once more so it answers with what it has: looping forever
  // would hang the request, and returning `null` would hand the unfinished
  // tool call back to the client, which has no way to resolve it.
  if (!payload) {
    const finalResponse = await callUpstream({
      ...loopBody,
      tools: (loopBody.tools ?? []).filter((tool) => !isWebSearchTool(tool)),
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
