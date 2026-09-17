// ---------------------------------------------------------------------------
// Responses <-> Chat tool translation
// ---------------------------------------------------------------------------

import { createErrorResponse } from '../../shared/http';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../../search/tool';
import {
  buildImageGenerationChatTool,
  IMAGE_GENERATION_CHAT_TOOL_NAME,
  IMAGE_GENERATION_TOOL_TYPE,
} from '../image-generation';
import type {
  ResponsesRequestBody,
  SupportedChatTool,
  SupportedResponsesTool,
  TranscriptMessage,
} from './types';

export const TOOL_SEARCH_PROXY_NAME = 'tool_search';
export const CUSTOM_TOOL_INPUT_FIELD = 'input';
export const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool.';

export const flattenNamespaceToolName = (
  namespace: string,
  name: string,
): string => {
  return `${namespace}__${name}`;
};

export const extractFunctionDefinition = (
  tool: Record<string, unknown>,
): Record<string, unknown> | null => {
  const nested =
    typeof tool.function === 'object' && tool.function !== null
      ? (tool.function as Record<string, unknown>)
      : {};

  const name = nested.name ?? tool.name;
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }

  const functionDef: Record<string, unknown> = { name };

  const description = nested.description ?? tool.description;
  if (description !== undefined) {
    functionDef.description = description;
  }

  const parameters = nested.parameters ?? tool.parameters;
  if (parameters !== undefined) {
    functionDef.parameters = parameters;
  }

  const strict = nested.strict ?? tool.strict;
  if (strict !== undefined) {
    functionDef.strict = strict;
  }

  return functionDef;
};

export const buildCustomToolDefinition = (
  tool: Record<string, unknown>,
): Record<string, unknown> | null => {
  const name = typeof tool.name === 'string' ? tool.name.trim() : '';

  if (!name) {
    return null;
  }

  const description =
    typeof tool.description === 'string' && tool.description.trim()
      ? tool.description
      : `Custom tool ${name}`;

  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        [CUSTOM_TOOL_INPUT_FIELD]: {
          type: 'string',
          description: CUSTOM_TOOL_INPUT_DESCRIPTION,
        },
      },
      required: [CUSTOM_TOOL_INPUT_FIELD],
    },
  };
};

export const buildToolSearchDefinition = (): Record<string, unknown> => {
  return {
    name: TOOL_SEARCH_PROXY_NAME,
    description:
      'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for tools or connectors to load.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of tool groups to return.',
        },
      },
      required: ['query'],
    },
  };
};

export const toSupportedChatTool = (
  tool: SupportedResponsesTool,
  namespace?: string,
): SupportedChatTool[] => {
  const toolType = typeof tool.type === 'string' ? tool.type : 'function';

  // Server-side search and fetch carry no function schema, so the generic
  // branch below drops them. Emit them as functions unconditionally and let the
  // route resolve the configured backend asynchronously. SearXNG needs local
  // configuration, while CodeBuddy search does not.
  //
  // The declared type is kept, not flattened: it is the only thing that
  // distinguishes a provider-executed tool from the client's own function, and
  // a client's own `web_search` must stay the client's to resolve.
  if (
    normalizeToolName(toolType).startsWith(
      normalizeToolName(WEB_SEARCH_TOOL_TYPE_PREFIX),
    )
  ) {
    const definition = buildWebSearchToolDefinition();

    return [
      {
        chatName: WEB_SEARCH_TOOL_NAME,
        kind: 'function',
        originalName: WEB_SEARCH_TOOL_NAME,
        serverType: toolType,
        tool: definition,
      },
    ];
  }

  // Fetch needs no deployment-level configuration — the local backend is always
  // available and the CodeBuddy backend needs only a credential — so it is
  // advertised unconditionally and gated later by the enable toggle.
  if (
    normalizeToolName(toolType).startsWith(
      normalizeToolName(WEB_FETCH_TOOL_TYPE_PREFIX),
    )
  ) {
    const definition = buildWebFetchToolDefinition();

    return [
      {
        chatName: WEB_FETCH_TOOL_NAME,
        kind: 'function',
        originalName: WEB_FETCH_TOOL_NAME,
        serverType: toolType,
        tool: definition,
      },
    ];
  }

  // Image generation has no chat-protocol equivalent, so the declaration is
  // rewritten as a function and the call is executed by the proxy. It is
  // advertised only on the chat path: the responses passthrough hands the
  // native declaration straight to the upstream, which supports it.
  if (toolType === IMAGE_GENERATION_TOOL_TYPE) {
    return [
      {
        chatName: IMAGE_GENERATION_CHAT_TOOL_NAME,
        kind: 'function' as const,
        originalName: IMAGE_GENERATION_TOOL_TYPE,
        tool: buildImageGenerationChatTool(),
      },
    ];
  }

  if (toolType === 'namespace') {
    const namespaceName = typeof tool.name === 'string' ? tool.name.trim() : '';
    const children = (
      Array.isArray(tool.tools)
        ? tool.tools
        : Array.isArray(tool.children)
          ? tool.children
          : []
    ).filter((item): item is SupportedResponsesTool => {
      return Boolean(item && typeof item === 'object');
    });

    if (!namespaceName || !children.length) {
      return [];
    }

    return children.flatMap((child) =>
      toSupportedChatTool(child, namespaceName),
    );
  }

  if (toolType === 'tool_search') {
    const definition = buildToolSearchDefinition();
    return [
      {
        chatName: TOOL_SEARCH_PROXY_NAME,
        kind: 'tool_search',
        originalName: TOOL_SEARCH_PROXY_NAME,
        tool: definition,
      },
    ];
  }

  if (toolType === 'custom') {
    const definition = buildCustomToolDefinition(tool);

    if (!definition || typeof definition.name !== 'string') {
      return [];
    }

    return [
      {
        chatName: definition.name,
        kind: 'custom',
        originalName: definition.name,
        tool: definition,
      },
    ];
  }

  const functionDef = extractFunctionDefinition(tool);

  if (!functionDef || typeof functionDef.name !== 'string') {
    return [];
  }

  const originalName = functionDef.name;
  const chatName = namespace
    ? flattenNamespaceToolName(namespace, originalName)
    : toolType === 'mcp' &&
        typeof tool.server_label === 'string' &&
        tool.server_label.trim()
      ? flattenNamespaceToolName(tool.server_label.trim(), originalName)
      : originalName;

  return [
    {
      chatName,
      kind: toolType === 'mcp' ? 'mcp' : 'function',
      namespace:
        namespace ||
        (typeof tool.server_label === 'string' ? tool.server_label : undefined),
      originalName,
      serverLabel:
        toolType === 'mcp' && typeof tool.server_label === 'string'
          ? tool.server_label
          : undefined,
      tool: {
        ...functionDef,
        name: chatName,
      },
    },
  ];
};

/**
 * True when the client declared an `image_generation` tool. Gating on this
 * keeps the ordinary path free of an extra upstream round trip.
 */
export const hasImageGenerationTool = (
  tools: ResponsesRequestBody['tools'],
): boolean => {
  return Boolean(
    tools?.some(
      (tool) =>
        typeof tool?.type === 'string' &&
        tool.type.toLowerCase().replaceAll('-', '_') ===
          IMAGE_GENERATION_TOOL_TYPE,
    ),
  );
};

export const getSupportedChatTools = (
  tools: ResponsesRequestBody['tools'],
): SupportedChatTool[] => {
  if (!tools?.length) {
    return [];
  }

  return tools.flatMap((tool) => toSupportedChatTool(tool));
};

export const findSupportedToolByName = (
  tools: ResponsesRequestBody['tools'],
  name: string,
): SupportedChatTool | null => {
  if (!tools?.length || !name) {
    return null;
  }

  return (
    getSupportedChatTools(tools).find(
      (tool) => tool.chatName === name || tool.originalName === name,
    ) ?? null
  );
};

export const hasSupportedLongerToolNamePrefix = (
  tools: ResponsesRequestBody['tools'],
  prefix: string,
): boolean => {
  if (!tools?.length || !prefix) {
    return false;
  }

  return getSupportedChatTools(tools).some((tool) => {
    const name = tool.chatName;
    return (
      typeof name === 'string' &&
      name.length > prefix.length &&
      name.startsWith(prefix)
    );
  });
};

export const buildResponsesToolCallOutputItem = (
  tools: ResponsesRequestBody['tools'],
  toolCall: {
    arguments: string;
    callId: string;
    id: string;
    name: string;
    status: 'completed' | 'in_progress';
  },
): Record<string, unknown> => {
  const originalTool = findSupportedToolByName(tools, toolCall.name);
  const itemType = originalTool?.kind === 'mcp' ? 'mcp_call' : 'function_call';
  const item: Record<string, unknown> = {
    id: toolCall.id,
    type: itemType,
    call_id: toolCall.callId,
    name: originalTool?.originalName ?? toolCall.name ?? 'function',
    arguments: toolCall.arguments,
    status: toolCall.status,
  };

  if (originalTool?.kind === 'mcp' && originalTool.serverLabel) {
    item.server_label = originalTool.serverLabel;
  }

  if (originalTool?.kind === 'function' && originalTool.namespace) {
    item.namespace = originalTool.namespace;
  }

  return item;
};

export const getResponsesToolCallArgumentDeltaEventType = (
  tools: ResponsesRequestBody['tools'],
  name: string,
):
  | 'response.function_call_arguments.delta'
  | 'response.mcp_call_arguments.delta' => {
  return findSupportedToolByName(tools, name)?.kind === 'mcp'
    ? 'response.mcp_call_arguments.delta'
    : 'response.function_call_arguments.delta';
};

export const translateResponsesToolsToChat = (
  tools: ResponsesRequestBody['tools'],
): unknown[] | undefined => {
  if (!tools?.length) {
    return undefined;
  }

  const supported = getSupportedChatTools(tools);
  if (!supported.length) {
    return undefined;
  }

  return supported.map((tool) => {
    return {
      // A provider-executed declaration keeps its declared type so it is still
      // recognisable downstream. Everything else is an ordinary function, which
      // upstream understands.
      type: tool.serverType ?? 'function',
      function: tool.tool,
    };
  });
};

export const translateResponsesToolChoiceToChat = (
  toolChoice: unknown,
): unknown => {
  if (typeof toolChoice !== 'object' || toolChoice === null) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;

  if (
    choice.type === 'function' &&
    choice.function &&
    typeof choice.function === 'object'
  ) {
    return toolChoice;
  }

  if (
    (choice.type === 'auto' ||
      choice.type === 'none' ||
      choice.type === 'required') &&
    typeof choice.type === 'string'
  ) {
    return choice.type;
  }

  // Responses API selects a function by name:
  // {type: 'function', name: 'fn'} -> chat schema {type: 'function', function: {name: 'fn'}}
  if (typeof choice.name === 'string') {
    return {
      type: 'function',
      function: { name: choice.name },
    };
  }

  return toolChoice;
};

export const translateResponsesToolChoiceToChatWithTools = (
  tools: ResponsesRequestBody['tools'],
  toolChoice: unknown,
): unknown => {
  const translated = translateResponsesToolChoiceToChat(toolChoice);

  if (typeof translated !== 'object' || translated === null) {
    return translated;
  }

  const choice = translated as Record<string, unknown>;

  if (
    choice.type === 'function' &&
    typeof choice.function === 'object' &&
    choice.function !== null
  ) {
    const functionChoice = choice.function as Record<string, unknown>;
    if (typeof functionChoice.name === 'string') {
      return {
        ...choice,
        function: {
          ...functionChoice,
          name: resolveChatToolName(tools, functionChoice.name),
        },
      };
    }
  }

  return translated;
};

export const getNamedToolChoice = (toolChoice: unknown): string | null => {
  if (typeof toolChoice !== 'object' || toolChoice === null) {
    return null;
  }

  const choice = toolChoice as Record<string, unknown>;

  if (typeof choice.name === 'string' && choice.name.length > 0) {
    return choice.name;
  }

  if (
    choice.type === 'function' &&
    typeof choice.function === 'object' &&
    choice.function !== null &&
    typeof (choice.function as Record<string, unknown>).name === 'string'
  ) {
    return (choice.function as Record<string, string>).name;
  }

  return null;
};

export const getResponsesCompatibilityError = (
  tools: ResponsesRequestBody['tools'],
  toolChoice: unknown,
): Response | null => {
  const supportedTools = getSupportedChatTools(tools);

  if (toolChoice === 'required' && supportedTools.length === 0) {
    return createErrorResponse(
      400,
      'tool_choice=required requires at least one supported tool for this /v1/responses adapter',
    );
  }

  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const choice = toolChoice as Record<string, unknown>;
    const isPretranslatedFunctionChoice =
      choice.type === 'function' &&
      typeof choice.function === 'object' &&
      choice.function !== null;
    const isSimpleChoiceType =
      choice.type === 'auto' ||
      choice.type === 'none' ||
      choice.type === 'required';
    const isNamedFunctionLikeChoice = typeof choice.name === 'string';

    if (
      !isPretranslatedFunctionChoice &&
      !isSimpleChoiceType &&
      !isNamedFunctionLikeChoice
    ) {
      return createErrorResponse(
        400,
        'Unsupported Responses tool_choice for this /v1/responses adapter',
      );
    }

    if (choice.type === 'required' && supportedTools.length === 0) {
      return createErrorResponse(
        400,
        'tool_choice=required requires at least one supported tool for this /v1/responses adapter',
      );
    }
  }

  const namedToolChoice = getNamedToolChoice(toolChoice);
  if (namedToolChoice) {
    const supportedNames = new Set(
      supportedTools
        .map((tool) => tool.originalName)
        .filter((name): name is string => typeof name === 'string'),
    );

    if (!supportedNames.has(namedToolChoice)) {
      return createErrorResponse(
        400,
        'tool_choice references a tool that is not available to this /v1/responses adapter',
      );
    }
  }

  return null;
};

export const resolveChatToolName = (
  tools: ResponsesRequestBody['tools'],
  name: string,
): string => {
  return findSupportedToolByName(tools, name)?.chatName ?? name;
};

export const normalizeTranscriptMessageToolNames = (
  transcript: TranscriptMessage[],
  tools: ResponsesRequestBody['tools'],
): TranscriptMessage[] => {
  return transcript.map((message) => {
    if (!message.tool_calls?.length) {
      return message;
    }

    return {
      ...message,
      tool_calls: message.tool_calls.map((toolCall) => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          name: resolveChatToolName(tools, toolCall.function.name),
        },
      })),
    };
  });
};
