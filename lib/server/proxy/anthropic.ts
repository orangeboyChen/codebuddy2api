import type { NextRequest } from 'next/server';

import {
  getDefaultModel,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../domain/config';
import type { DebugTrace } from '../domain/debug';

import { proxyChatCompletions, type ChatRequestBody } from './codebuddy';
import {
  getServerToolStreamEvent,
  getServerToolExecutions,
  type ServerToolExecution,
} from './web-search-loop';
import {
  anthropicStreamErrorChunks,
  createStreamCloser,
  toUpstreamTimeoutMessage,
} from '../shared/upstream-timeout';
import { extractErrorMessage } from '../shared/http';
import {
  markServerTool,
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../search/tool';

const MAX_STREAM_FRAME_LENGTH = 1_000_000;

// ---------------------------------------------------------------------------
// Anthropic Messages API types
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: { type?: string };
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  type?: string;
}

interface AnthropicThinkingConfig {
  type?: string;
  budget_tokens?: number;
}

interface AnthropicMessagesRequestBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: AnthropicThinkingConfig;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI response types (mirrors of codebuddy.ts internals)
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

interface OpenAIChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  reasoning?: string;
}

interface OpenAIChatChoice {
  index?: number;
  message?: OpenAIChatMessage;
  delta?: OpenAIChatMessage;
  finish_reason?: string | null;
}

interface OpenAIStreamError {
  error?: { message?: string; status?: number };
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIUsage;
}

interface ChatTextBlock {
  cache_control?: { type?: string };
  text: string;
  type: 'text';
}

type ChatTextContent = string | ChatTextBlock[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createAnthropicId = (prefix: string): string => {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }

        return JSON.stringify(item);
      })
      .join('');
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
};

const mapTextPartsToChatContent = (
  parts: Array<string | ChatTextBlock>,
): ChatTextContent => {
  const textParts = parts.filter((part) =>
    typeof part === 'string' ? part.length > 0 : part.text.length > 0,
  );
  const hasStructuredText = textParts.some((part) => typeof part !== 'string');

  if (!hasStructuredText) {
    return textParts.join('\n');
  }

  return textParts.flatMap((part, index) => [
    ...(index > 0 ? [{ type: 'text' as const, text: '\n' }] : []),
    typeof part === 'string' ? { type: 'text' as const, text: part } : part,
  ]);
};

const extractSystemText = (
  system: string | AnthropicContentBlock[] | undefined,
): ChatTextContent => {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  return mapTextPartsToChatContent(
    system.map((block) => {
      if (block.type === 'text') {
        const text = block.text ?? '';

        return block.cache_control
          ? { type: 'text', text, cache_control: block.cache_control }
          : text;
      }

      return stringifyContent(block);
    }),
  );
};

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: ChatTextContent | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

const decodeOpaqueServerToolContent = (value: unknown): unknown => {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );

    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
};

const formatAnthropicServerToolResult = (
  block: AnthropicContentBlock,
): string => {
  if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
    return block.content
      .map((value, index) => {
        const item =
          value && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : {};
        const decoded = decodeOpaqueServerToolContent(item.encrypted_content);
        const source =
          decoded && typeof decoded === 'object'
            ? (decoded as Record<string, unknown>)
            : item;
        const title = String(source.title ?? item.title ?? '').trim();
        const url = String(source.url ?? item.url ?? '').trim();
        const text = String(
          source.content ?? source.snippet ?? source.text ?? '',
        ).trim();

        return [
          `${index + 1}. ${title || url || 'Search result'}`,
          ...(url ? [`URL: ${url}`] : []),
          ...(text ? [text] : []),
        ].join('\n');
      })
      .join('\n\n');
  }

  if (
    block.type === 'web_fetch_tool_result' &&
    block.content &&
    typeof block.content === 'object'
  ) {
    const result = block.content as Record<string, unknown>;
    const document =
      result.content && typeof result.content === 'object'
        ? (result.content as Record<string, unknown>)
        : null;
    const source =
      document?.source && typeof document.source === 'object'
        ? (document.source as Record<string, unknown>)
        : null;
    const url = typeof result.url === 'string' ? result.url : '';
    const text = typeof source?.data === 'string' ? source.data : '';

    return [url, text].filter(Boolean).join('\n\n');
  }

  return typeof block.content === 'string'
    ? block.content
    : stringifyContent(block.content);
};

const mapAnthropicContentToChat = (
  content: string | AnthropicContentBlock[],
  role: 'user' | 'assistant',
): ChatMessage[] => {
  if (typeof content === 'string') {
    return [{ role, content }];
  }

  const parts: Array<string | ChatTextBlock> = [];
  const toolCalls: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }> = [];
  const toolResults: ChatMessage[] = [];
  const messages: ChatMessage[] = [];
  const flushAssistantMessage = (): void => {
    const textContent = mapTextPartsToChatContent(parts);

    if (!toolCalls.length && !textContent.length) {
      return;
    }

    messages.push({
      role: 'assistant',
      content: textContent.length ? textContent : null,
      ...(toolCalls.length ? { tool_calls: [...toolCalls] } : {}),
    });
    parts.length = 0;
    toolCalls.length = 0;
  };

  for (const block of content) {
    if (block.type === 'text') {
      const text = block.text ?? '';

      parts.push(
        block.cache_control
          ? { type: 'text', text, cache_control: block.cache_control }
          : text,
      );
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      toolCalls.push({
        id: block.id ?? createAnthropicId('toolu'),
        type: 'function',
        function: {
          name: block.name ?? 'unknown',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (
      block.type === 'tool_result' ||
      block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result'
    ) {
      const resultMessage: ChatMessage = {
        role: 'tool',
        content: formatAnthropicServerToolResult(block),
        tool_call_id: block.tool_use_id ?? '',
      };

      if (role === 'assistant') {
        flushAssistantMessage();
        messages.push(resultMessage);
      } else {
        toolResults.push(resultMessage);
      }
    } else if (block.type === 'thinking') {
      // Skip thinking blocks in conversation history for OpenAI compat.
    } else {
      parts.push(stringifyContent(block));
    }
  }

  if (role === 'user') {
    messages.push(...toolResults);
    const textContent = mapTextPartsToChatContent(parts);
    if (textContent.length) {
      messages.push({ role: 'user', content: textContent });
    }
  } else {
    flushAssistantMessage();
  }

  return messages;
};

const mapAnthropicMessagesToChat = (
  messages: AnthropicMessage[],
): ChatMessage[] => {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    const mapped = mapAnthropicContentToChat(msg.content, msg.role);

    if (mapped.length === 0) {
      continue;
    }

    for (const item of mapped) {
      result.push({
        ...item,
      });
    }
  }

  return result;
};

const mapAnthropicToolsToChat = (
  tools: AnthropicTool[] | undefined,
): unknown[] | undefined => {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => {
    const mapped = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
    const normalizedType = normalizeToolName(tool.type ?? '');
    const serverDeclared = [
      WEB_SEARCH_TOOL_TYPE_PREFIX,
      WEB_FETCH_TOOL_TYPE_PREFIX,
    ].some((prefix) => normalizedType.startsWith(normalizeToolName(prefix)));

    return serverDeclared ? markServerTool(mapped) : mapped;
  });
};

const shouldBridgeAnthropicServerTools = async (
  tools: AnthropicTool[] | undefined,
): Promise<boolean> => {
  const names = new Set(
    (tools ?? []).map((tool) => normalizeToolName(tool.name)),
  );
  const [searchEnabled, fetchEnabled] = await Promise.all([
    names.has(normalizeToolName(WEB_SEARCH_TOOL_NAME))
      ? isWebSearchEnabled()
      : false,
    names.has(normalizeToolName(WEB_FETCH_TOOL_NAME))
      ? isWebFetchEnabled()
      : false,
  ]);

  return searchEnabled || fetchEnabled;
};

const mapAnthropicToolChoiceToChat = (toolChoice: unknown): unknown => {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return toolChoice;
  }

  const tc = toolChoice as { type?: string; name?: string };

  if (tc.type === 'auto') {
    return 'auto';
  }

  if (tc.type === 'any') {
    return 'required';
  }

  if (tc.type === 'tool' && tc.name) {
    return {
      type: 'function',
      function: { name: tc.name },
    };
  }

  if (tc.type === 'none') {
    return 'none';
  }

  return toolChoice;
};

const buildChatRequestBody = async (
  body: AnthropicMessagesRequestBody,
): Promise<Record<string, unknown>> => {
  const systemText = extractSystemText(body.system);
  const chatMessages = mapAnthropicMessagesToChat(body.messages ?? []);

  const messages: ChatMessage[] = [];
  const disableParallelToolUse =
    body.tool_choice && typeof body.tool_choice === 'object'
      ? (body.tool_choice as { disable_parallel_tool_use?: unknown })
          .disable_parallel_tool_use
      : undefined;

  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  messages.push(...chatMessages);

  const result: Record<string, unknown> = {
    model:
      typeof body.model === 'string' && body.model.trim()
        ? body.model
        : await getDefaultModel('claude-sonnet-4.6'),
    messages,
    stream: body.stream ?? false,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: mapAnthropicToolsToChat(body.tools),
    tool_choice: mapAnthropicToolChoiceToChat(body.tool_choice),
    parallel_tool_calls:
      typeof disableParallelToolUse === 'boolean'
        ? !disableParallelToolUse
        : undefined,
  };

  // Pass through thinking/reasoning config so upstream models that support
  // extended thinking can honor it.
  if (body.thinking) {
    result.thinking = body.thinking;
  }

  return result;
};

// ---------------------------------------------------------------------------
// Response translation: OpenAI → Anthropic (non-streaming)
// ---------------------------------------------------------------------------

const mapOpenAIUsageToAnthropic = (
  usage: OpenAIUsage | undefined,
  serverToolExecutions: ServerToolExecution[] = [],
): Record<string, unknown> => {
  const cacheCreationTokens =
    usage?.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  // prompt_tokens is the total prompt count including cached tokens.
  // Anthropic reports cached/created tokens separately, so input_tokens
  // must be the non-cache remainder to avoid double-counting.
  const inputTokens = Math.max(
    0,
    (usage?.prompt_tokens ?? 0) - cacheCreationTokens - cacheReadTokens,
  );
  const outputTokens = usage?.completion_tokens ?? 0;

  const mapped: Record<string, number | Record<string, number>> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  };

  if (serverToolExecutions.length) {
    mapped.server_tool_use = {
      web_search_requests: serverToolExecutions.filter(
        (execution) => execution.type === 'web_search',
      ).length,
      web_fetch_requests: serverToolExecutions.filter(
        (execution) => execution.type === 'web_fetch',
      ).length,
    };
  }

  return mapped;
};

const encodeOpaqueServerToolContent = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

const buildAnthropicServerToolBlocks = (
  executions: ServerToolExecution[],
): AnthropicContentBlock[] =>
  executions.flatMap((execution) => {
    const id = createAnthropicId('srvtoolu');
    const result =
      execution.type === 'web_search'
        ? {
            type: 'web_search_tool_result',
            tool_use_id: id,
            content: execution.result.results.map((item) => ({
              type: 'web_search_result',
              url: item.url ?? '',
              title: item.title ?? '',
              encrypted_content: encodeOpaqueServerToolContent(item),
            })),
          }
        : {
            type: 'web_fetch_tool_result',
            tool_use_id: id,
            content: {
              type: 'web_fetch_result',
              url: execution.result.url ?? execution.input.url,
              content: {
                type: 'document',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: execution.result.content,
                },
              },
            },
          };

    return [
      {
        type: 'server_tool_use',
        id,
        name: execution.type,
        input: execution.input,
      },
      result,
    ];
  });

const mapOpenAIResponseToAnthropic = (
  openaiResponse: OpenAIChatResponse,
  model: string,
  serverToolExecutions: ServerToolExecution[] = [],
): Record<string, unknown> => {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;
  const contentBlocks: AnthropicContentBlock[] =
    buildAnthropicServerToolBlocks(serverToolExecutions);

  // Thinking / reasoning content
  const reasoningText = message?.reasoning_content ?? message?.reasoning ?? '';

  if (reasoningText) {
    contentBlocks.push({
      type: 'thinking',
      thinking: reasoningText,
    });
  }

  // Text content
  const textContent =
    typeof message?.content === 'string' ? message.content : '';

  if (textContent) {
    contentBlocks.push({
      type: 'text',
      text: textContent,
    });
  }

  // Tool calls
  const toolCalls = message?.tool_calls ?? [];

  for (const call of toolCalls) {
    let input: unknown = {};

    try {
      input = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      input = {};
    }

    contentBlocks.push({
      type: 'tool_use',
      id: call.id ?? createAnthropicId('toolu'),
      name: call.function?.name ?? 'unknown',
      input,
    });
  }

  const stopReason = mapFinishReasonToAnthropic(
    choice?.finish_reason,
    toolCalls.length > 0,
  );

  return {
    id: openaiResponse.id ?? createAnthropicId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapOpenAIUsageToAnthropic(
      openaiResponse.usage,
      serverToolExecutions,
    ),
  };
};

const mapFinishReasonToAnthropic = (
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): string => {
  if (hasToolCalls || finishReason === 'tool_calls') {
    return 'tool_use';
  }

  if (finishReason === 'length') {
    return 'max_tokens';
  }

  if (finishReason === 'stop' || !finishReason) {
    return 'end_turn';
  }

  return 'end_turn';
};

// ---------------------------------------------------------------------------
// Response translation: OpenAI SSE → Anthropic SSE (streaming)
// ---------------------------------------------------------------------------

interface StreamingToolUseState {
  id: string;
  name: string;
  input: string;
  index: number;
  started: boolean;
  blockEmitted: boolean;
}

const mapOpenAIStreamToAnthropicSSE = (
  upstreamResponse: Response,
  model: string,
  options?: {
    emitMessageStart?: boolean;
    initialContentBlockCount?: number;
    messageId?: string;
    serverToolExecutions?: ServerToolExecution[];
  },
): Response => {
  if (!upstreamResponse.body) {
    return new Response(null, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const messageId = options?.messageId ?? createAnthropicId('msg');
  const serverToolExecutions =
    options?.serverToolExecutions ?? getServerToolExecutions(upstreamResponse);
  const serverToolUseIds = new Map<string, string>();
  const toolUseStates = new Map<string, StreamingToolUseState>();
  let nextToolIndex = 0;
  let started = options?.emitMessageStart === false;
  let thinkingStarted = false;
  let thinkingBlockIndex = -1;
  let textStarted = false;
  let textBlockIndex = -1;
  // Tracks how many content blocks (thinking + text) have been opened
  // so tool_use blocks get correct sequential indices even after the
  // prior blocks are closed mid-stream.
  let contentBlockCount = options?.initialContentBlockCount ?? 0;
  let finishReason: string | null = null;
  let hasToolCalls = false;
  let usage: OpenAIUsage | undefined;

  const enqueueEvent = (event: Record<string, unknown>): void => {
    controller.enqueue(
      encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );
  };

  let controller: ReadableStreamDefaultController<Uint8Array>;

  // Close any open text/thinking block before starting a tool_use block.
  // Anthropic streaming requires each block to be stopped before the next.
  const closeOpenTextBlocks = (): void => {
    if (thinkingStarted) {
      enqueueEvent({
        type: 'content_block_stop',
        index: thinkingBlockIndex,
      });
      thinkingStarted = false;
    }

    if (textStarted) {
      enqueueEvent({
        type: 'content_block_stop',
        index: textBlockIndex,
      });
      textStarted = false;
    }
  };

  const processChunk = (chunk: OpenAIStreamChunk): void => {
    if (!started) {
      started = true;
      enqueueEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: chunk.usage?.prompt_tokens ?? 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    }

    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (!delta) {
      return;
    }

    // Reasoning / thinking content
    const reasoningText = delta.reasoning_content ?? delta.reasoning ?? '';

    if (reasoningText) {
      if (!thinkingStarted) {
        thinkingBlockIndex = contentBlockCount;
        thinkingStarted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: thinkingBlockIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        });
        contentBlockCount++;
      }

      enqueueEvent({
        type: 'content_block_delta',
        index: thinkingBlockIndex,
        delta: {
          type: 'thinking_delta',
          thinking: reasoningText,
        },
      });
    }

    // Text content
    if (delta.content) {
      if (!textStarted) {
        // Close the thinking block before starting text so Anthropic
        // stream consumers see properly ordered, non-overlapping blocks.
        closeOpenTextBlocks();

        textBlockIndex = contentBlockCount;
        textStarted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        });
        contentBlockCount++;
      }

      enqueueEvent({
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      });
    }

    // Tool calls
    if (delta.tool_calls?.length) {
      hasToolCalls = true;

      // Anthropic streaming requires each content block to be closed
      // before the next one starts. If we already opened a text or
      // thinking block, close it now so the tool_use block is well-formed.
      closeOpenTextBlocks();

      for (const call of delta.tool_calls) {
        const callId = call.id ?? `toolu_${nextToolIndex}`;
        const key = callId;

        if (!toolUseStates.has(key)) {
          const blockIndex = contentBlockCount + nextToolIndex;

          toolUseStates.set(key, {
            id: callId,
            name: '',
            input: '',
            index: blockIndex,
            started: false,
            blockEmitted: false,
          });
          nextToolIndex++;
        }

        const state = toolUseStates.get(key)!;

        // Accumulate name fragments (upstream may stream the function
        // name across multiple deltas, e.g. "look" + "up").
        if (call.function?.name) {
          state.name += call.function.name;
        }

        // Emit content_block_start lazily — once we have a name and at
        // least one arguments fragment, so the block header carries the
        // full tool name instead of a partial fragment.
        if (!state.blockEmitted && state.name && call.function?.arguments) {
          state.blockEmitted = true;
          enqueueEvent({
            type: 'content_block_start',
            index: state.index,
            content_block: {
              type: 'tool_use',
              id: state.id,
              name: state.name,
              input: {},
            },
          });
        }

        if (call.function?.arguments) {
          state.input += call.function.arguments;
          enqueueEvent({
            type: 'content_block_delta',
            index: state.index,
            delta: {
              type: 'input_json_delta',
              partial_json: call.function.arguments,
            },
          });
        }
      }
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  const finalize = (): void => {
    // Close any remaining open text/thinking blocks.
    closeOpenTextBlocks();

    // Close tool use blocks
    for (const [, state] of toolUseStates) {
      // If the block start was never emitted (e.g. name-only deltas
      // with no arguments), emit it now so the block is well-formed.
      if (!state.blockEmitted) {
        state.blockEmitted = true;
        enqueueEvent({
          type: 'content_block_start',
          index: state.index,
          content_block: {
            type: 'tool_use',
            id: state.id,
            name: state.name || 'unknown',
            input: {},
          },
        });
      }

      enqueueEvent({
        type: 'content_block_stop',
        index: state.index,
      });
    }

    const stopReason = mapFinishReasonToAnthropic(finishReason, hasToolCalls);

    enqueueEvent({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: mapOpenAIUsageToAnthropic(usage, serverToolExecutions),
    });

    enqueueEvent({
      type: 'message_stop',
    });
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let streamRejected = false;
  const closer = createStreamCloser();
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      controller = ctrl;
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      const rejectStream = (
        message = 'Upstream SSE frame exceeds the maximum size',
        status?: number,
      ): void => {
        streamRejected = true;
        enqueueEvent({
          type: 'error',
          error: {
            // An upstream status names the failure precisely, so it decides
            // the type: 429 has to arrive as `rate_limit_error` or a client
            // that retries on that type alone stops retrying an exhausted
            // quota. Without one, fall back to the message: an oversized frame
            // is a malformed stream (`invalid_request_error`), while an
            // upstream deadline is the server failing (`api_error`, the type
            // clients treat as retryable).
            type:
              typeof status === 'number'
                ? anthropicErrorType(status)
                : message.includes('did not produce output')
                  ? 'api_error'
                  : 'invalid_request_error',
            message,
          },
        });
      };

      const flushFrames = (frames: string[]): void => {
        for (const frame of frames) {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            rejectStream();
            return;
          }
          const line = frame
            .split('\n')
            .find((segment) => segment.startsWith('data: '));

          if (!line) {
            continue;
          }

          const raw = line.slice(6).trim();

          if (!raw || raw === '[DONE]') {
            continue;
          }

          try {
            const chunk = JSON.parse(raw) as OpenAIStreamChunk;
            const serverToolEvent = getServerToolStreamEvent(chunk);

            if (serverToolEvent?.phase === 'call') {
              closeOpenTextBlocks();
              const index = contentBlockCount++;
              const toolUseId = createAnthropicId('srvtoolu');
              serverToolUseIds.set(serverToolEvent.invocation.id, toolUseId);
              enqueueEvent({
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'server_tool_use',
                  id: toolUseId,
                  name: serverToolEvent.invocation.type,
                  input: {},
                },
              });
              enqueueEvent({
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(
                    serverToolEvent.invocation.input,
                  ),
                },
              });
              enqueueEvent({ type: 'content_block_stop', index });
              continue;
            }

            if (serverToolEvent?.phase === 'result') {
              closeOpenTextBlocks();
              serverToolExecutions.push(serverToolEvent.execution);
              const index = contentBlockCount++;
              const resultBlock = buildAnthropicServerToolBlocks([
                serverToolEvent.execution,
              ])[1];
              enqueueEvent({
                type: 'content_block_start',
                index,
                content_block: {
                  ...resultBlock,
                  tool_use_id: serverToolUseIds.get(
                    serverToolEvent.execution.id,
                  ),
                },
              });
              enqueueEvent({ type: 'content_block_stop', index });
              continue;
            }

            const upstreamError = chunk as OpenAIStreamError;
            if (upstreamError.error?.message) {
              rejectStream(
                upstreamError.error.message,
                upstreamError.error.status,
              );
              return;
            }
            processChunk(chunk);
          } catch {
            // Skip unparseable frames
          }
        }
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            if (buffer.trim()) {
              flushFrames([buffer]);
            }
            if (!streamRejected) {
              finalize();
            }
            releaseReader();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            rejectStream();
          } else {
            flushFrames(frames);
          }
          if (streamRejected) {
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
        }
      };

      void pump().catch((error) => {
        if (cancelled) return;
        const timeoutMessage = toUpstreamTimeoutMessage(error);

        if (timeoutMessage === null) {
          closer.mark();
          controller.error(error);
          return;
        }

        void reader?.cancel().then(
          () => undefined,
          () => undefined,
        );
        releaseReader();
        closer.fail(controller, anthropicStreamErrorChunks(timeoutMessage));
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      closer.mark();
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
};

const createAnthropicServerToolEventStream = (
  request: NextRequest,
  chatBody: Record<string, unknown>,
  model: string,
  debugTrace?: DebugTrace,
): Response => {
  const encoder = new TextEncoder();
  const messageId = createAnthropicId('msg');
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const enqueueEvent = (event: Record<string, unknown>): void => {
        if (cancelled) return;
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      };

      enqueueEvent({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });

      const run = async (): Promise<void> => {
        const upstreamResponse = await proxyChatCompletions(
          request,
          chatBody as ChatRequestBody,
          undefined,
          debugTrace,
          '/v1/messages',
          { emitStreamEvents: true },
        );

        if (cancelled) {
          await upstreamResponse.body?.cancel();
          return;
        }

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          // A rate limit has to arrive as `rate_limit_error`, or a client that
          // retries on that type alone will treat an exhausted quota as a
          // generic failure and stop retrying — so the upstream status drives
          // the event type even though the envelope is already streaming and
          // the HTTP status cannot be changed.
          const message = upstreamResponse.ok
            ? 'Upstream request failed'
            : await getUpstreamErrorMessage(upstreamResponse).catch(
                () => 'Upstream request failed',
              );

          enqueueEvent({
            type: 'error',
            error: {
              type: anthropicErrorType(upstreamResponse.status),
              message,
            },
          });
          controller.close();
          return;
        }

        const mappedResponse = mapOpenAIStreamToAnthropicSSE(
          upstreamResponse,
          model,
          {
            emitMessageStart: false,
            initialContentBlockCount: 0,
            messageId,
            serverToolExecutions: [],
          },
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

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

const getUpstreamErrorMessage = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!text) return 'Upstream CodeBuddy request failed';

  try {
    return extractErrorMessage(JSON.parse(text) as unknown) ?? text;
  } catch {
    return text;
  }
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleMessagesRequest = async (
  request: NextRequest,
  body: AnthropicMessagesRequestBody,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  if (!body.messages?.length) {
    return createAnthropicError(400, 'messages is required');
  }

  try {
    const chatBody = await buildChatRequestBody(body);

    if (body.stream && (await shouldBridgeAnthropicServerTools(body.tools))) {
      return createAnthropicServerToolEventStream(
        request,
        chatBody,
        String(chatBody.model ?? 'unknown'),
        debugTrace,
      );
    }

    const upstreamResponse = await proxyChatCompletions(
      request,
      chatBody as ChatRequestBody,
      undefined,
      debugTrace,
      '/v1/messages',
    );

    if (!upstreamResponse.ok) {
      return createAnthropicError(
        upstreamResponse.status,
        await getUpstreamErrorMessage(upstreamResponse),
      );
    }

    const model = String(chatBody.model ?? 'unknown');
    const serverToolExecutions = getServerToolExecutions(upstreamResponse);

    if (body.stream) {
      return mapOpenAIStreamToAnthropicSSE(upstreamResponse, model);
    }

    const payload = (await upstreamResponse.json()) as OpenAIChatResponse;

    return Response.json(
      mapOpenAIResponseToAnthropic(payload, model, serverToolExecutions),
    );
  } catch (error) {
    return createAnthropicError(
      500,
      error instanceof Error ? error.message : 'Unexpected messages error',
    );
  }
};

export const anthropicErrorType = (status: number): string =>
  status === 401
    ? 'authentication_error'
    : status === 403
      ? 'permission_error'
      : status === 404
        ? 'not_found_error'
        : status === 413
          ? 'request_too_large'
          : status === 429
            ? 'rate_limit_error'
            : status === 529
              ? 'overloaded_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error';

export const createAnthropicError = (
  status: number,
  message: string,
): Response => {
  const type = anthropicErrorType(status);

  return Response.json(
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    { status },
  );
};
