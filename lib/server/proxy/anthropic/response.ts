import { createAnthropicId } from './content';
import type {
  AnthropicContentBlock,
  OpenAIChatResponse,
  OpenAIUsage,
} from './types';
import type { ServerToolExecution, ServerToolTurn } from '../web-search-loop';

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
 * Lays a server-tool turn out the way Anthropic does: each hop contributes its
 * own thinking and text, followed by the tool blocks that hop triggered.
 *
 * `turns` carries the per-hop grouping the OpenAI-shaped payload cannot. Under
 * that protocol a multi-hop turn collapses into one `content` string and one
 * `reasoning_content` string, which loses where one hop's reasoning ends and the
 * next begins — so the grouping has to be recovered before it is joined, which
 * is why the loop emits it alongside the strings rather than this file
 * reconstructing it.
 *
 * Anthropic's own server tools run multiple hops inside one assistant message,
 * and a client replaying that message expects `[thinking] [text] [tool_use]
 * [tool_result] [thinking] [text]`. Gathering the blocks by kind instead — every
 * tool ahead of all the prose — puts each search before the reasoning that asked
 * for it and merges hops that were never contiguous.
 */
export const buildAnthropicTurnBlocks = (
  turns: ServerToolTurn[],
): AnthropicContentBlock[] => {
  const blocks: AnthropicContentBlock[] = [];

  turns.forEach((turn) => {
    if (turn.reasoning) {
      blocks.push(buildThinkingBlock(turn.reasoning));
    }

    if (turn.text) {
      blocks.push({ type: 'text', text: turn.text });
    }

    blocks.push(...buildAllAnthropicServerToolBlocks(turn.executions));
  });

  return blocks;
};

export const mapOpenAIResponseToAnthropic = (
  openaiResponse: OpenAIChatResponse,
  model: string,
  serverToolExecutions: ServerToolExecution[] = [],
  turns?: ServerToolTurn[],
): Record<string, unknown> => {
  const choice = openaiResponse.choices?.[0];
  const message = choice?.message;

  // Thinking / reasoning content
  const reasoningText = message?.reasoning_content ?? message?.reasoning ?? '';

  // Text content
  const textContent =
    typeof message?.content === 'string' ? message.content : '';

  // With per-hop grouping the turns already hold every block in order, prose
  // included. Without it — no server tool ran, or a path that never grouped the
  // hops — fall back to Anthropic's own order: thinking and text first, then
  // the server-tool blocks they led to.
  const contentBlocks: AnthropicContentBlock[] = turns
    ? buildAnthropicTurnBlocks(turns)
    : [];

  if (!turns) {
    if (reasoningText) {
      contentBlocks.push(buildThinkingBlock(reasoningText));
    }

    if (textContent) {
      contentBlocks.push({ type: 'text', text: textContent });
    }

    contentBlocks.push(
      ...buildAllAnthropicServerToolBlocks(serverToolExecutions),
    );
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
