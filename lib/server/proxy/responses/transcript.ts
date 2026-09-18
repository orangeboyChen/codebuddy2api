// ---------------------------------------------------------------------------
// Transcript construction and usage mapping
// ---------------------------------------------------------------------------

import { getDefaultModel } from '../../domain/config';
import { stringifyContent } from '../../shared/content';
import { extractImageUrl, isImageContentPart } from '../codebuddy';
import { createResponseOutputId, normalizeToolCallId } from './ids';
import {
  getValidatedPreviousSession,
  MAX_RESPONSE_TRANSCRIPT_MESSAGES,
} from './session';
import { findSupportedToolByName } from './tools';
import type {
  ChatContentPart,
  ChatResponseToolCall,
  ResponsesInputItem,
  ResponsesRequestBody,
  ResponseSession,
  ResponseSessionDefaults,
  StreamingToolCallState,
  TranscriptContent,
  TranscriptMessage,
} from './types';

export const buildAssistantTranscriptToolCalls = (
  toolCalls: ChatResponseToolCall[],
  tools?: ResponsesRequestBody['tools'],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCalls.length) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    id: normalizeToolCallId(toolCall.id, index),
    type: 'function',
    function: {
      name:
        findSupportedToolByName(tools, toolCall.function?.name ?? '')
          ?.originalName ??
        toolCall.function?.name ??
        'function',
      arguments: toolCall.function?.arguments ?? '',
    },
  }));
};

export const buildStreamingAssistantTranscriptToolCalls = (
  toolCallStates: StreamingToolCallState[],
  tools?: ResponsesRequestBody['tools'],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCallStates.length) {
    return undefined;
  }

  return toolCallStates.map((toolCallState) => ({
    id: toolCallState.callId,
    type: 'function',
    function: {
      arguments: toolCallState.arguments,
      name:
        findSupportedToolByName(tools, toolCallState.name)?.originalName ??
        toolCallState.name,
    },
  }));
};

export const getAssistantTranscriptContent = (
  outputText: string,
  toolCalls: TranscriptMessage['tool_calls'] | undefined,
): string | null => {
  return toolCalls?.length ? outputText || null : outputText;
};

/**
 * Keeps image parts as structured content so the chat path can rebuild them
 * upstream. Text parts are still flattened: the transcript is persisted across
 * turns and replayed as Chat messages, and the Responses converter only
 * recognises images in the OpenAI `image_url` shape.
 */
export const mapInputContentToTranscriptContent = (
  content: unknown,
): TranscriptContent | null => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content.filter((part) => part !== null && part !== undefined);

  if (!parts.some(isImageContentPart)) {
    return null;
  }

  const mapped = parts.flatMap((part): ChatContentPart[] => {
    if (typeof part === 'string') {
      return [part];
    }

    if (isImageContentPart(part)) {
      const imageUrl = extractImageUrl(part);

      return imageUrl
        ? [{ image_url: { url: imageUrl }, type: 'image_url' }]
        : [];
    }

    if (part && typeof part === 'object' && 'text' in part) {
      return [String((part as { text?: unknown }).text ?? '')];
    }

    return [];
  });

  return mapped.length ? mapped : null;
};

/**
 * Marks an `encrypted_content` value we minted, so we can tell it apart from a
 * blob issued by someone else.
 *
 * Not a security measure. Codex never opens this field — it only echoes it — so
 * plaintext round-trips fine, but a marker is what stops us from reading a
 * genuinely encrypted blob as if it were reasoning text.
 */
export const REASONING_PREFIX = 'cbreason1:';

/**
 * Pulls readable reasoning out of a replayed `reasoning` item.
 *
 * Only values we minted are used: anything else — an OpenAI-issued blob, say —
 * is opaque ciphertext, and forwarding it upstream would send gibberish where
 * reasoning belongs. The summary is the fallback in that case.
 *
 * The Agents SDK sends summaries as `summary: [{type: 'summary_text', text}]`,
 * so a client that never received our blob still gets its reasoning through.
 */
export const extractReasoningFromItem = (item: ResponsesInputItem): string => {
  const blob = item.encrypted_content;

  if (typeof blob === 'string' && blob.startsWith(REASONING_PREFIX)) {
    return blob.slice(REASONING_PREFIX.length);
  }

  if (!Array.isArray(item.summary)) {
    return '';
  }

  return item.summary
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      if (entry && typeof entry === 'object' && 'text' in entry) {
        return String((entry as { text?: unknown }).text ?? '');
      }

      return '';
    })
    .join('');
};

export const mapInputItemToMessage = (
  item: ResponsesInputItem,
): TranscriptMessage | null => {
  if (item.type === 'reasoning' || item.type === 'compaction') {
    // Reasoning is not a message. Without this branch the item fell through to
    // the plain-message case at the bottom, where it has neither `role` nor
    // `content` — becoming an empty `{role:'user', content:''}` entry that the
    // chat upstream sees as a turn the user never sent, repeated on every
    // later turn of the conversation.
    //
    // Signal the reasoning back to the caller instead, which attaches it to the
    // assistant message it accompanies. Returning `null` when there is nothing
    // to recover keeps an empty reasoning item from emitting a message at all.
    const reasoning = extractReasoningFromItem(item);

    return reasoning ? { role: 'assistant', content: null, reasoning } : null;
  }

  if (item.type === 'function_call' || item.type === 'mcp_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: item.call_id ?? createResponseOutputId(),
          type: 'function',
          function: {
            name: item.name ?? 'function',
            arguments: item.arguments ?? '',
          },
        },
      ],
    };
  }

  if (item.type === 'function_call_output' || item.type === 'mcp_call_output') {
    // A tool may return an image, e.g. a screenshot. Keep it structured so the
    // Responses converter can rebuild it as an image; stringifying would hand
    // the model the base64 payload as text.
    const outputContent =
      mapInputContentToTranscriptContent(item.output) ??
      stringifyContent(item.output);

    if (item.call_id) {
      return {
        role: 'tool',
        content: outputContent,
        tool_call_id: item.call_id,
      };
    }

    return {
      role: 'user',
      content: outputContent,
    };
  }

  if (item.type === 'mcp_approval_response') {
    return {
      role: 'user',
      content: JSON.stringify(item),
    };
  }

  // Call items the proxy itself mints and a stateless client replays verbatim
  // from the previous response's `output`. They carry no text, so the
  // plain-message case below would turn each one into an empty
  // `{role:'user', content:''}` entry — one phantom user turn per search the
  // previous turn ran, repeated on every later turn.
  if (
    item.type === 'web_search_call' ||
    item.type === 'image_generation_call'
  ) {
    return null;
  }

  // Every other item type returns above, so what is left is a plain message:
  // either one with a declared `type: 'message'`, or one carrying only
  // `role`/`content`. Images are kept structured so the chat path can rebuild
  // them; a message without an image stays flattened.
  const imageContent = mapInputContentToTranscriptContent(item.content);

  if (imageContent !== null) {
    return {
      role: item.role ?? 'user',
      content: imageContent,
    };
  }

  return {
    role: item.role ?? 'user',
    content: item.text ?? stringifyContent(item.content),
  };
};

export const getStreamingToolCallCanonicalKey = (
  toolCall: ChatResponseToolCall,
  position: number,
): string => {
  if (toolCall.id) {
    return `id:${toolCall.id}`;
  }

  if (typeof toolCall.index === 'number') {
    return `index:${toolCall.index}`;
  }

  return `position:${position}`;
};

export const getStreamingToolCallLookupKeys = (
  toolCall: ChatResponseToolCall,
  position: number,
): string[] => {
  if (toolCall.id || typeof toolCall.index === 'number') {
    return [
      toolCall.id ? `id:${toolCall.id}` : null,
      typeof toolCall.index === 'number' ? `index:${toolCall.index}` : null,
    ].filter((key): key is string => key !== null);
  }

  return [`position:${position}`];
};

export const prepareTranscript = async (
  body: ResponsesRequestBody,
  accessKeyId: string | null,
  previousSession?: ResponseSession,
): Promise<{
  defaults: ResponseSessionDefaults;
  model: string;
  transcript: TranscriptMessage[];
  previousResponseId: string | null;
}> => {
  const previousResponseId = body.previous_response_id ?? null;
  const resolvedPreviousSession =
    previousSession ??
    (await getValidatedPreviousSession(previousResponseId, accessKeyId));

  const transcript = (resolvedPreviousSession?.transcript ?? []).slice(
    -MAX_RESPONSE_TRANSCRIPT_MESSAGES,
  );
  // Reasoning recovered from replayed reasoning items, awaiting the assistant
  // message it belongs to. Declared here so it spans the whole input array.
  let pendingReasoning = '';
  while (transcript[0]?.role === 'tool') {
    transcript.shift();
  }
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model
      : (resolvedPreviousSession?.model ?? (await getDefaultModel()));
  const additionalTools = Array.isArray(body.input)
    ? body.input.flatMap((item) =>
        item?.type === 'additional_tools' && Array.isArray(item.tools)
          ? item.tools
          : [],
      )
    : [];
  const baseTools = body.tools ?? resolvedPreviousSession?.defaults.tools;
  const requestTools = [...(baseTools ?? []), ...additionalTools];
  const defaults = {
    instructions:
      body.instructions ??
      resolvedPreviousSession?.defaults.instructions ??
      undefined,
    metadata:
      body.metadata ?? resolvedPreviousSession?.defaults.metadata ?? undefined,
    tools: requestTools.length > 0 ? requestTools : baseTools,
    tool_choice:
      body.tool_choice ??
      resolvedPreviousSession?.defaults.tool_choice ??
      undefined,
  };

  if (body.messages?.length) {
    body.messages.forEach((item) => {
      transcript.push({
        role: item.role ?? 'user',
        content:
          mapInputContentToTranscriptContent(item.content) ??
          stringifyContent(item.content),
      });
    });
  } else if (typeof body.input === 'string') {
    transcript.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item) => {
      if (item.type === 'additional_tools') return;

      const message = mapInputItemToMessage(item);

      if (!message) {
        return;
      }

      // A reasoning item yields a reasoning-only entry. Fold it into the next
      // assistant message so the upstream sees the reasoning where it belongs
      // — attached to the turn that produced it — instead of as a bare turn.
      // Anything left unconsumed at the end is dropped: reasoning with no
      // following assistant message has nothing to attach to.
      if (message.reasoning && !message.content && !message.tool_calls) {
        pendingReasoning += message.reasoning;
        return;
      }

      // Attach any reasoning carried forward from a preceding reasoning item.
      // `message.reasoning` is only ever set by the mapper below — clients
      // cannot send it, since `ResponsesInputItem` has no such field — so
      // there is no pre-existing value to merge with.
      if (pendingReasoning) {
        message.reasoning = pendingReasoning;
        pendingReasoning = '';
      }

      transcript.push(message);
    });
  }

  return {
    defaults,
    model,
    transcript,
    previousResponseId,
  };
};

export const toResponsesUsageNumber = (value: unknown): number => {
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return numeric;
};

export const mapChatUsageToResponses = (
  usage: unknown,
): Record<string, unknown> => {
  if (!usage || typeof usage !== 'object') {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    };
  }

  const value = usage as {
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
    completion_thinking_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    prompt_cache_write_tokens?: unknown;
    prompt_tokens?: unknown;
    prompt_tokens_details?: {
      cache_creation_tokens?: unknown;
      cached_tokens?: unknown;
    };
    total_tokens?: unknown;
  };
  const outputTokens = toResponsesUsageNumber(value.completion_tokens);
  const cachedTokens = toResponsesUsageNumber(
    value.prompt_tokens_details?.cached_tokens ??
      value.input_tokens_details?.cached_tokens ??
      value.cache_read_input_tokens ??
      value.prompt_cache_hit_tokens,
  );
  const cacheCreationTokens = toResponsesUsageNumber(
    value.prompt_tokens_details?.cache_creation_tokens ??
      value.cache_creation_input_tokens ??
      value.prompt_cache_write_tokens,
  );
  const reasoningTokens = toResponsesUsageNumber(
    value.completion_tokens_details?.reasoning_tokens ??
      value.completion_thinking_tokens,
  );
  // Chat usage is the single source of truth for both shapes. Keep the
  // Responses counters faithful to it so clients never see zeroed metrics.
  // prompt_tokens already covers its cached and created subsets, so the
  // split counters are only summed when prompt_tokens is missing. Otherwise
  // cached tokens would exceed the reported input total.
  const inputTokens = toResponsesUsageNumber(
    value.prompt_tokens ??
      toResponsesUsageNumber(value.prompt_cache_miss_tokens) +
        cachedTokens +
        cacheCreationTokens,
  );

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens:
      toResponsesUsageNumber(value.total_tokens) || inputTokens + outputTokens,
  };
};
