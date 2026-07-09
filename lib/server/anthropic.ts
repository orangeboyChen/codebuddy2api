import type { NextRequest } from 'next/server';

import { getAvailableModels } from './config';

import { proxyChatCompletions } from './codebuddy';

// ---------------------------------------------------------------------------
// Anthropic Messages API types
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string;
  text?: string;
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

const extractSystemText = (
  system: string | AnthropicContentBlock[] | undefined,
): string => {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  return system
    .map((block) => {
      if (block.type === 'text') {
        return block.text ?? '';
      }

      return stringifyContent(block);
    })
    .join('\n');
};

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string | null;
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

const mapAnthropicContentToChat = (
  content: string | AnthropicContentBlock[],
  role: 'user' | 'assistant',
): ChatMessage[] => {
  if (typeof content === 'string') {
    return [{ role, content }];
  }

  // Collect text, structured tool calls, and tool results separately so
  // the OpenAI upstream receives proper tool_calls / tool messages instead
  // of flattened text. This preserves the call↔result relationship that
  // multi-step tool loops rely on.
  const parts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }> = [];
  const toolResults: ChatMessage[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text ?? '');
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? createAnthropicId('toolu'),
        type: 'function',
        function: {
          name: block.name ?? 'unknown',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else if (block.type === 'tool_result') {
      const resultContent =
        typeof block.content === 'string'
          ? block.content
          : stringifyContent(block.content);
      toolResults.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: block.tool_use_id ?? '',
      });
    } else if (block.type === 'thinking') {
      // Skip thinking blocks in conversation history for OpenAI compat.
    } else {
      parts.push(stringifyContent(block));
    }
  }

  const textContent = parts.filter(Boolean).join('\n');
  const messages: ChatMessage[] = [];

  // Emit tool results before any free-form text so the tool result stays
  // adjacent to the preceding assistant tool_calls in the OpenAI message
  // history. Upstream APIs that validate tool-call adjacency can reject
  // or ignore a tool result separated from its call by a user message.
  if (role === 'user') {
    messages.push(...toolResults);
  }

  // For an assistant message with tool calls, content can be null per the
  // OpenAI spec. For user messages, keep text if present.
  if (role === 'assistant') {
    messages.push({
      role: 'assistant',
      content: textContent || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  } else if (textContent) {
    messages.push({ role: 'user', content: textContent });
  }

  // For assistant messages, tool results are not expected, but push any
  // that slipped through after the assistant message.
  if (role === 'assistant') {
    messages.push(...toolResults);
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

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
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

const buildChatRequestBody = (
  body: AnthropicMessagesRequestBody,
): Record<string, unknown> => {
  const systemText = extractSystemText(body.system);
  const chatMessages = mapAnthropicMessagesToChat(body.messages ?? []);

  const messages: ChatMessage[] = [];

  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  messages.push(...chatMessages);

  const result: Record<string, unknown> = {
    model: body.model ?? getAvailableModels()[0] ?? 'claude-sonnet-4.6',
    messages,
    stream: body.stream ?? false,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    tools: mapAnthropicToolsToChat(body.tools),
    tool_choice: mapAnthropicToolChoiceToChat(body.tool_choice),
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
): Record<string, number> => {
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

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  };
};

const mapOpenAIResponseToAnthropic = (
  openaiResponse: OpenAIChatResponse,
  model: string,
): Record<string, unknown> => {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;
  const contentBlocks: AnthropicContentBlock[] = [];

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
    usage: mapOpenAIUsageToAnthropic(openaiResponse.usage),
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

  const messageId = createAnthropicId('msg');
  const toolUseStates = new Map<string, StreamingToolUseState>();
  let nextToolIndex = 0;
  let started = false;
  let thinkingStarted = false;
  let thinkingBlockIndex = -1;
  let textStarted = false;
  let textBlockIndex = -1;
  // Tracks how many content blocks (thinking + text) have been opened
  // so tool_use blocks get correct sequential indices even after the
  // prior blocks are closed mid-stream.
  let contentBlockCount = 0;
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
      usage: mapOpenAIUsageToAnthropic(usage),
    });

    enqueueEvent({
      type: 'message_stop',
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (ctrl) => {
      controller = ctrl;
      const reader = upstreamResponse.body!.getReader();
      let buffer = '';

      const flushFrames = (frames: string[]): void => {
        for (const frame of frames) {
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
            processChunk(chunk);
          } catch {
            // Skip unparseable frames
          }
        }
      };

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            flushFrames([buffer]);
          }

          finalize();
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        flushFrames(frames);
        await pump();
      };

      void pump();
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleMessagesRequest = async (
  request: NextRequest,
  body: AnthropicMessagesRequestBody,
): Promise<Response> => {
  if (!body.messages?.length) {
    return createAnthropicError(400, 'messages is required');
  }

  try {
    const chatBody = buildChatRequestBody(body);
    const upstreamResponse = await proxyChatCompletions(request, chatBody);

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const model = String(chatBody.model ?? 'unknown');

    if (body.stream) {
      return mapOpenAIStreamToAnthropicSSE(upstreamResponse, model);
    }

    const payload = (await upstreamResponse.json()) as OpenAIChatResponse;

    return Response.json(mapOpenAIResponseToAnthropic(payload, model));
  } catch (error) {
    return createAnthropicError(
      500,
      error instanceof Error ? error.message : 'Unexpected messages error',
    );
  }
};

const createAnthropicError = (status: number, message: string): Response => {
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message,
      },
    },
    { status },
  );
};
