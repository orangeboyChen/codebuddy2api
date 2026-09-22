import { getDefaultModel } from '../../domain/config';
import { stringifyContent } from '../../shared/content';
import {
  normalizeToolName,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../../search/tool';
import {
  buildChatImageUrl,
  createAnthropicId,
  extractSystemText,
  mapContentPartsToChat,
  stripTokenUsageReminder,
} from './content';
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequestBody,
  AnthropicTool,
  ChatContentPart,
  ChatImageBlock,
  ChatMessage,
} from './types';

// ---------------------------------------------------------------------------
// Request translation: Anthropic → OpenAI
// ---------------------------------------------------------------------------

export const decodeOpaqueServerToolContent = (value: unknown): unknown => {
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

export const formatAnthropicServerToolResult = (
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

  // Nested images are emitted as real image parts by
  // `collectAnthropicNestedImages`, so they are excluded here to keep their
  // base64 payload out of the text.
  if (Array.isArray(block.content)) {
    return stringifyContent(
      block.content.filter((value) => {
        return !(
          value &&
          typeof value === 'object' &&
          (value as AnthropicContentBlock).type === 'image'
        );
      }),
    );
  }

  return typeof block.content === 'string'
    ? block.content
    : stringifyContent(block.content);
};

/**
 * Images nested inside a `tool_result` content array, e.g. a screenshot a tool
 * returned. The outer block is handled by the `tool_result` branch, whose
 * formatter stringifies nested content — so without extracting them here the
 * model would receive the base64 payload as text.
 */
export const collectAnthropicNestedImages = (
  block: AnthropicContentBlock,
): ChatImageBlock[] => {
  if (!Array.isArray(block.content)) {
    return [];
  }

  return block.content.flatMap((value): ChatImageBlock[] => {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const nested = value as AnthropicContentBlock;

    if (nested.type !== 'image') {
      return [];
    }

    const imageUrl = buildChatImageUrl(nested.source);

    return imageUrl
      ? [{ type: 'image_url', image_url: { url: imageUrl } }]
      : [];
  });
};

export const mapAnthropicContentToChat = (
  content: string | AnthropicContentBlock[],
  role: 'user' | 'assistant',
): ChatMessage[] => {
  if (typeof content === 'string') {
    const text = stripTokenUsageReminder(content);

    // A message that was nothing but the client's usage hint leaves no content
    // to forward, and an empty message is not one the upstream accepts either.
    return text !== content && !text.trim() ? [] : [{ role, content: text }];
  }

  const parts: ChatContentPart[] = [];
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
  /**
   * Reasoning recovered from thinking blocks in this assistant message.
   *
   * Attached to the message the blocks belong to rather than sent on its own:
   * a bare reasoning entry is not a valid chat message, and the upstream needs
   * the reasoning alongside the text and tool calls it produced.
   */
  let pendingReasoning = '';
  const flushAssistantMessage = (): void => {
    const content = mapContentPartsToChat(parts);
    const hasContent = typeof content === 'string' ? content.length > 0 : true;

    if (!toolCalls.length && !hasContent && !pendingReasoning) {
      return;
    }

    messages.push({
      role: 'assistant',
      content: hasContent ? content : null,
      ...(toolCalls.length ? { tool_calls: [...toolCalls] } : {}),
      // `reasoning` is the field the CodeBuddy chat upstream round-trips. It
      // is not part of the OpenAI schema, but the upstream accepts it and
      // ignoring an unknown field costs nothing if it ever stops doing so.
      ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
    });
    parts.length = 0;
    toolCalls.length = 0;
    pendingReasoning = '';
  };

  for (const block of content) {
    if (block.type === 'text') {
      const raw = block.text ?? '';
      const text = stripTokenUsageReminder(raw);

      // The hint rides along in the same message as the real text, so only a
      // block that was nothing else is dropped.
      if (text !== raw && !text.trim()) {
        continue;
      }

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
      const nestedImages = collectAnthropicNestedImages(block);

      const resultMessage: ChatMessage = {
        role: 'tool',
        content: nestedImages.length
          ? mapContentPartsToChat([
              formatAnthropicServerToolResult(block),
              ...nestedImages,
            ])
          : formatAnthropicServerToolResult(block),
        tool_call_id: block.tool_use_id ?? '',
      };

      if (role === 'assistant') {
        flushAssistantMessage();
        messages.push(resultMessage);
      } else {
        toolResults.push(resultMessage);
      }
    } else if (
      block.type === 'thinking' ||
      block.type === 'redacted_thinking'
    ) {
      // Replaying prior-turn reasoning is required inside a tool-use turn and
      // harmless elsewhere, so recover it instead of dropping it.
      //
      // The `thinking` field carries the reasoning. A `signature` is only ever
      // read when it is one we minted on the Responses path; a genuine
      // Anthropic signature is ciphertext, and forwarding it upstream would put
      // gibberish where reasoning belongs.
      //
      // `redacted_thinking` has no readable text at all, only `data`, but must
      // still be matched here: without this branch it fell through to
      // `stringifyContent` and the model received a JSON dump of the opaque
      // payload as if it were user prose.
      const reasoning = block.thinking ?? '';

      if (reasoning) {
        pendingReasoning = pendingReasoning
          ? `${pendingReasoning}${reasoning}`
          : reasoning;
      }
    } else if (block.type === 'image' && block.source) {
      // Anthropic sends `{ type: 'image', source: { type: 'base64' | 'url',
      // media_type, data | url } }`. Emit a real image block so the upstream
      // model sees the image; without this branch the block fell through to
      // `stringifyContent` and the model received a JSON dump of the base64
      // payload as text. An `image` block with no `source` is not a real
      // Anthropic image, so it keeps the generic stringified handling.
      const imageUrl = buildChatImageUrl(block.source);

      parts.push(
        imageUrl
          ? {
              type: 'image_url',
              image_url: { url: imageUrl },
              // Preserve an explicit cache breakpoint, matching how text
              // blocks carry `cache_control` through. Without this the
              // requested breakpoint is dropped and `applyPromptCacheControl`
              // falls back to its own automatic placement.
              ...(block.cache_control
                ? { cache_control: block.cache_control }
                : {}),
            }
          : stringifyContent(block),
      );
    } else {
      parts.push(stringifyContent(block));
    }
  }

  if (role === 'user') {
    messages.push(...toolResults);
    const content = mapContentPartsToChat(parts);
    const hasContent = typeof content === 'string' ? content.length > 0 : true;
    if (hasContent) {
      messages.push({ role: 'user', content });
    }
  } else {
    flushAssistantMessage();
  }

  return messages;
};

export const mapAnthropicMessagesToChat = (
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

/**
 * Translates Anthropic tool declarations into the chat shape upstream takes.
 *
 * A provider-executed declaration — `web_search_20250305`,
 * `web_fetch_20250910` — keeps its declared type rather than being flattened to
 * `function`. That type is the only thing distinguishing a server tool from the
 * client's own function, and Claude Code relies on the difference: it declares
 * `WebSearch` as an ordinary function and resolves it itself, so a translation
 * that collapsed the two would hand a client-owned tool to the proxy.
 *
 * Nothing sends the preserved type upstream: a request carrying one is always
 * rewritten before it leaves, because upstream has no server tools.
 */
export const mapAnthropicToolsToChat = (
  tools: AnthropicTool[] | undefined,
): unknown[] | undefined => {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => {
    const type = typeof tool.type === 'string' ? tool.type.trim() : '';
    const serverDeclared = [
      WEB_SEARCH_TOOL_TYPE_PREFIX,
      WEB_FETCH_TOOL_TYPE_PREFIX,
    ].some((prefix) =>
      normalizeToolName(type).startsWith(normalizeToolName(prefix)),
    );

    if (serverDeclared) {
      // Everything the client declared travels with it — `max_uses`,
      // `allowed_domains`, `user_location`. Only the *shape* changes: upstream
      // is a Chat API, so the declaration has to look like a function, while
      // the declared type is kept on `type` so the proxy can still recognise
      // it as a server tool downstream.
      return { ...tool, type, function: { name: tool.name } };
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
  });
};

export const mapAnthropicToolChoiceToChat = (toolChoice: unknown): unknown => {
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

export const buildChatRequestBody = async (
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
  // extended thinking can honor it. Both vocabularies are carried because the
  // client may speak either one, and `buildUpstreamBody` reduces them to the
  // single effort the model advertises.
  if (body.thinking) {
    result.thinking = body.thinking;
  }

  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort) {
    result.reasoning_effort = body.reasoning_effort;
  }

  return result;
};
