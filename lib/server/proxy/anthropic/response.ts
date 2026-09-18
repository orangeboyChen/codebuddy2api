import { createAnthropicId } from './content';
import type {
  AnthropicContentBlock,
  OpenAIChatResponse,
  OpenAIUsage,
} from './types';
import type { ServerToolExecution, ServerToolSegment } from '../server-tools';

// ---------------------------------------------------------------------------
// Response translation: OpenAI → Anthropic (non-streaming)
// ---------------------------------------------------------------------------

export const mapOpenAIUsageToAnthropic = (
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

export const encodeOpaqueServerToolContent = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

export const buildAnthropicServerToolBlocks = (
  execution: ServerToolExecution,
): AnthropicContentBlock[] => {
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
};

export const buildAllAnthropicServerToolBlocks = (
  executions: ServerToolExecution[],
): AnthropicContentBlock[] =>
  executions.flatMap(buildAnthropicServerToolBlocks);

/**
 * We do not mint a `signature` on this path. It would have to duplicate the
 * `thinking` text to be replayable, which puts the reasoning on the wire twice
 * for callers that count it — and the block already replays fine: Anthropic
 * clients echo `thinking` back, which is what inbound handling reads.
 */
export const buildThinkingBlock = (
  thinking: string,
): AnthropicContentBlock => ({
  type: 'thinking',
  thinking,
});

/**
 * Lays a server-tool turn out the way Anthropic does: what the model wrote
 * before the search, the search itself, then the answer the results produced.
 *
 * The order is the whole point. A client replays this content array as the
 * assistant turn, and Anthropic's own server tools interleave — `[thinking]
 * [text] [server_tool_use] [web_search_tool_result] [text]` — so gathering the
 * blocks by kind instead would show every search ahead of the reasoning that
 * asked for it, and put the conclusion before its evidence.
 */
export const buildAnthropicServerToolTurnBlocks = (
  segments: ServerToolSegment[],
): AnthropicContentBlock[] =>
  // Interleaved, not gathered by kind: each hop's prose belongs immediately
  // before the blocks it asked for. Collecting all the prose first would show
  // the user a conclusion ahead of the search that produced it.
  segments.flatMap((segment) => [
    ...(segment.reasoning ? [buildThinkingBlock(segment.reasoning)] : []),
    ...(segment.text ? [{ text: segment.text, type: 'text' as const }] : []),
    ...buildAllAnthropicServerToolBlocks(segment.executions),
  ]);

export const mapOpenAIResponseToAnthropic = (
  openaiResponse: OpenAIChatResponse,
  model: string,
  serverToolExecutions: ServerToolExecution[] = [],
  segments?: ServerToolSegment[],
): Record<string, unknown> => {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;

  // Thinking / reasoning content
  const reasoningText = message?.reasoning_content ?? message?.reasoning ?? '';

  // Text content
  const textContent =
    typeof message?.content === 'string' ? message.content : '';

  const contentBlocks: AnthropicContentBlock[] = segments
    ? buildAnthropicServerToolTurnBlocks(segments)
    : [];

  if (!segments) {
    if (reasoningText) {
      contentBlocks.push(buildThinkingBlock(reasoningText));
    }

    if (textContent) {
      contentBlocks.push({ type: 'text', text: textContent });
    }

    contentBlocks.push(
      ...buildAllAnthropicServerToolBlocks(serverToolExecutions),
    );
  } else {
    // The closing half of the turn: the answer written once the results were
    // in. It follows every block above rather than preceding them.
    if (reasoningText) {
      contentBlocks.push(buildThinkingBlock(reasoningText));
    }

    if (textContent) {
      contentBlocks.push({ type: 'text', text: textContent });
    }
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

export const mapFinishReasonToAnthropic = (
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
