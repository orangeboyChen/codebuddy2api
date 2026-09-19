import { readReasoning, stringifyContent } from '../../shared/content';
import { resolveHyResponsesReasoning } from '../../shared/hy-thought-depth';
import type { ChatRequestBody } from './types';

export const isImageContentPart = (part: unknown): boolean => {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const value = part as { image_url?: unknown; type?: unknown };

  if (value.type === 'image_url' || value.type === 'input_image') {
    return true;
  }

  // Accept the shapes an OpenAI-compatible client may send even when `type`
  // is absent or unexpected: any part carrying an image URL is an image.
  return (
    typeof value.image_url === 'string' ||
    Boolean(
      value.image_url &&
      typeof value.image_url === 'object' &&
      typeof (value.image_url as { url?: unknown }).url === 'string',
    )
  );
};

/**
 * Reads the image URL out of a Responses `input_image` / `image_url` part.
 * Returns undefined when the part carries no usable URL, so callers can drop it
 * rather than forwarding a block the upstream would reject.
 */
export const extractImageUrl = (part: unknown): string | undefined => {
  if (!part || typeof part !== 'object') {
    return undefined;
  }

  const { image_url: imageUrl } = part as { image_url?: unknown };

  // `input_image` carries a bare URL string; the OpenAI Chat-style
  // `image_url` part nests it under `url`.
  if (typeof imageUrl === 'string') {
    return imageUrl || undefined;
  }

  if (
    imageUrl &&
    typeof imageUrl === 'object' &&
    typeof (imageUrl as { url?: unknown }).url === 'string'
  ) {
    return (imageUrl as { url: string }).url || undefined;
  }

  return undefined;
};

/**
 * Builds the `reasoning` item that carries a prior turn's reasoning on a
 * Responses request.
 *
 * The Responses protocol has no per-message reasoning field the way the chat
 * protocol does: reasoning is its own input item, emitted ahead of the
 * assistant message it belongs to. Without it, converting a chat request that
 * replays reasoning would hand the upstream the turn's text with nothing of
 * the reasoning that produced it.
 *
 * `summary` is the shape the Agents SDK replays and the one our own transcript
 * mapper reads back, so a reasoning item survives the round trip.
 */
export const buildResponsesReasoningItem = (
  reasoning: string,
): Record<string, unknown> => ({
  summary: [{ text: reasoning, type: 'summary_text' }],
  type: 'reasoning',
});

/**
 * The reasoning items to put ahead of a chat message, if it carries any.
 */
export const chatMessageReasoningItems = (
  message:
    | {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
        role?: unknown;
      }
    | undefined,
): Array<Record<string, unknown>> => {
  const reasoning = readReasoning(message);

  return reasoning.trim() ? [buildResponsesReasoningItem(reasoning)] : [];
};

export const mapChatContentToResponses = (
  content: unknown,
): Array<Record<string, unknown>> => {
  if (!Array.isArray(content)) {
    return [
      {
        text: stringifyContent(content),
        type: 'input_text',
      },
    ];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (typeof part === 'string') {
      return [{ text: part, type: 'input_text' }];
    }
    if (!part || typeof part !== 'object') {
      return [{ text: JSON.stringify(part), type: 'input_text' }];
    }
    const value = part as {
      image_url?: string | { detail?: unknown; url?: unknown };
      text?: unknown;
      type?: unknown;
    };
    if (value.type === 'image_url') {
      const imageUrl =
        typeof value.image_url === 'string'
          ? value.image_url
          : value.image_url?.url;
      if (typeof imageUrl === 'string' && imageUrl) {
        const detail =
          typeof value.image_url === 'object' &&
          typeof value.image_url.detail === 'string'
            ? value.image_url.detail
            : undefined;
        return [
          {
            image_url: imageUrl,
            ...(detail ? { detail } : {}),
            type: 'input_image',
          },
        ];
      }
    }
    if (value.type === 'input_image' && typeof value.image_url === 'string') {
      return [{ image_url: value.image_url, type: 'input_image' }];
    }
    if (typeof value.text === 'string') {
      return [{ text: value.text, type: 'input_text' }];
    }
    return [{ text: JSON.stringify(value), type: 'input_text' }];
  });
};

export const translateChatToolChoiceToResponses = (
  toolChoice: unknown,
): unknown => {
  if (typeof toolChoice === 'string') return toolChoice;
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const value = toolChoice as {
    function?: { name?: unknown };
    name?: unknown;
    type?: unknown;
  };
  if (value.type !== 'function') return toolChoice;
  const name = value.function?.name ?? value.name;
  return typeof name === 'string' ? { name, type: 'function' } : toolChoice;
};

export const translateChatResponseFormatToResponses = (
  responseFormat: unknown,
): Record<string, unknown> | undefined => {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  const value = responseFormat as {
    json_schema?: Record<string, unknown>;
    type?: unknown;
  };
  if (value.type === 'json_object') {
    return { format: { type: 'json_object' } };
  }
  if (value.type !== 'json_schema' || !value.json_schema) return undefined;
  const schema = value.json_schema;
  if (typeof schema.name !== 'string' || !schema.name) return undefined;
  return {
    format: {
      ...(schema.description ? { description: schema.description } : {}),
      name: schema.name,
      schema: schema.schema ?? { type: 'object', properties: {} },
      ...(typeof schema.strict === 'boolean' ? { strict: schema.strict } : {}),
      type: 'json_schema',
    },
  };
};

export const translateChatThinkingToResponses = (
  thinking: Record<string, unknown> | undefined,
  reasoningEffort: string | undefined,
): Record<string, unknown> | undefined => {
  if (!thinking)
    return reasoningEffort ? { effort: reasoningEffort } : undefined;

  if (thinking.type === 'disabled') return { effort: 'none' };
  if (thinking.type !== 'adaptive' && thinking.type !== 'enabled') {
    return undefined;
  }

  const budgetTokens =
    typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : Number.NaN;
  const effort = reasoningEffort
    ? reasoningEffort
    : Number.isFinite(budgetTokens)
      ? budgetTokens <= 2_048
        ? 'low'
        : budgetTokens <= 8_192
          ? 'medium'
          : 'high'
      : undefined;

  return {
    ...(effort ? { effort } : {}),
    summary: 'auto',
  };
};

/**
 * Codex sends `reasoning.effort` in the OpenAI vocabulary, which Hy models do
 * not accept, so the effort is rewritten onto the Hy vocabulary before the body
 * is forwarded.
 */
export const resolveHyResponsesBody = async (
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const reasoning = await resolveHyResponsesReasoning(
    typeof body.model === 'string' ? body.model : undefined,
    body.reasoning as Record<string, unknown> | undefined,
  );

  return { ...body, reasoning };
};

export const normalizeResponsesUpstreamBody = async (
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const { messages, ...rest } = body;

  if (rest.input !== undefined || !Array.isArray(messages)) {
    return resolveHyResponsesBody(rest);
  }

  const systemInstructions = messages
    .filter((message) => {
      return (
        message &&
        typeof message === 'object' &&
        ((message as { role?: unknown }).role === 'system' ||
          (message as { role?: unknown }).role === 'developer')
      );
    })
    .map((message) => {
      return stringifyContent((message as { content?: unknown }).content);
    })
    .filter(Boolean)
    .join('\n\n');
  const input = messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const value = message as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      role?: unknown;
    };
    if (value.role === 'system' || value.role === 'developer') return [];
    const role = value.role === 'assistant' ? 'assistant' : 'user';
    return [
      ...chatMessageReasoningItems(value),
      {
        content: mapChatContentToResponses(value.content),
        role,
      },
    ];
  });

  const existingInstructions =
    typeof rest.instructions === 'string' ? rest.instructions.trim() : '';
  const instructions = [existingInstructions, systemInstructions]
    .filter(Boolean)
    .join('\n\n');

  return resolveHyResponsesBody({
    ...rest,
    ...(instructions ? { instructions } : {}),
    input,
  });
};

export const buildResponsesBodyFromChat = async (
  body: ChatRequestBody,
): Promise<Record<string, unknown>> => {
  const instructions = body.messages
    ?.filter(
      (message) => message.role === 'system' || message.role === 'developer',
    )
    .map((message) => stringifyContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input =
    body.messages
      ?.filter(
        (message) => message.role !== 'system' && message.role !== 'developer',
      )
      .map((message) => {
        if (message.role === 'tool') {
          // A tool may return an image, e.g. a screenshot. The upstream
          // `function_call_output` carries `output` as structured content, so
          // an image part is preserved there; stringifying it would hand the
          // model a base64 dump instead of the image.
          const toolOutput = Array.isArray(message.content)
            ? message.content.filter(
                (part) => part !== null && part !== undefined,
              )
            : message.content;
          const hasImage = Array.isArray(toolOutput)
            ? toolOutput.some(isImageContentPart)
            : isImageContentPart(toolOutput);

          return {
            call_id: message.tool_call_id,
            output: hasImage
              ? mapChatContentToResponses(toolOutput)
              : stringifyContent(toolOutput),
            type: 'function_call_output',
          };
        }
        const toolCalls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];
        const functionCalls = toolCalls.flatMap((toolCall) => {
          if (!toolCall || typeof toolCall !== 'object') return [];
          const call = toolCall as {
            function?: { arguments?: unknown; name?: unknown };
            id?: unknown;
          };
          if (typeof call.function?.name !== 'string') return [];
          return [
            {
              arguments: String(call.function.arguments ?? ''),
              call_id: String(call.id ?? crypto.randomUUID()),
              name: call.function.name,
              type: 'function_call',
            },
          ];
        });
        const content = mapChatContentToResponses(message.content);
        const hasContent = content.some((part) => {
          return (
            (part.type === 'input_text' && Boolean(part.text)) ||
            (part.type === 'input_image' && Boolean(part.image_url))
          );
        });
        const shouldOmitMessage =
          message.role === 'assistant' &&
          functionCalls.length > 0 &&
          !hasContent;

        return [
          ...chatMessageReasoningItems(message),
          ...(shouldOmitMessage
            ? []
            : [
                {
                  content,
                  role: message.role === 'assistant' ? 'assistant' : 'user',
                },
              ]),
          ...functionCalls,
        ];
      })
      .flat() ?? [];
  const tools = body.tools?.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const value = tool as {
      function?: Record<string, unknown>;
      type?: unknown;
    };
    const definition: Record<string, unknown> =
      value.type === 'function' && value.function ? value.function : value;
    if (typeof definition.name !== 'string') return [];
    return [
      {
        ...definition,
        parameters: definition.parameters ?? { type: 'object', properties: {} },
        type: 'function',
      },
    ];
  });
  const text = translateChatResponseFormatToResponses(body.response_format);
  const reasoning = await resolveHyResponsesReasoning(
    body.model,
    translateChatThinkingToResponses(body.thinking, body.reasoning_effort),
  );

  return {
    ...(instructions ? { instructions } : {}),
    input,
    max_output_tokens: body.max_tokens ?? body.max_completion_tokens,
    model: body.model,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    top_p: body.top_p,
    ...(tools?.length ? { tools } : {}),
    ...(body.tool_choice
      ? { tool_choice: translateChatToolChoiceToResponses(body.tool_choice) }
      : {}),
    ...(text ? { text } : {}),
  };
};

export const getUnsupportedResponsesChatOptions = (
  body: ChatRequestBody,
): string[] => {
  return [
    body.frequency_penalty !== undefined ? 'frequency_penalty' : null,
    body.presence_penalty !== undefined ? 'presence_penalty' : null,
    body.thinking !== undefined &&
    !translateChatThinkingToResponses(body.thinking, body.reasoning_effort)
      ? 'thinking'
      : null,
  ].filter((name): name is string => Boolean(name));
};
