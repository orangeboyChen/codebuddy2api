import type { NextRequest } from 'next/server';

import {
  getActiveConfig,
  getAvailableModels,
  getCodeBuddyApiEndpoint,
} from './config';
import { resolveCredentialForRequest } from './credentials';
import { createErrorResponse, getRequestHeaderMap } from './http';
import { recordModelUsage } from './stats';

interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ChatRequestBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: unknown;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: Record<string, unknown>;
  reasoning_effort?: string;
}

interface ChatStreamDelta {
  content?: string;
  role?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
  }>;
}

interface ChatStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  usage?: unknown;
  choices?: Array<{
    delta?: ChatStreamDelta;
    finish_reason?: string | null;
    index?: number;
  }>;
}

type ToolCallChunk = NonNullable<ChatStreamDelta['tool_calls']>[number];

interface ToolCallMapping {
  id: string;
  index: number;
}

interface ToolCallNormalizationState {
  mappings: Map<string, ToolCallMapping>;
  nextIndex: number;
}

type ResolvedAuth =
  | {
      type: 'api_key';
      apiKey: string;
      userId: string;
    }
  | {
      type: 'bearer';
      bearerToken: string;
      userId: string;
      credentialData: Record<string, unknown>;
    };

const normalizeMessages = (messages: OpenAIMessage[]): OpenAIMessage[] => {
  const filtered = messages.filter(
    (item) => item.role && item.content !== undefined,
  );

  if (filtered.length === 1 && filtered[0]?.role === 'user') {
    return [
      {
        role: 'system',
        content: 'You are a helpful assistant.',
      },
      ...filtered,
    ];
  }

  // Preserve role:'tool' messages so the OpenAI-compatible upstream
  // receives a valid tool_calls/tool-result pair for multi-step tool loops.
  return filtered;
};

const getResolvedAuth = (): ResolvedAuth => {
  const config = getActiveConfig();
  const mode = config.CODEBUDDY_AUTH_MODE;
  const apiKey = config.CODEBUDDY_API_KEY?.trim();

  if (mode === 'api_key' || (mode === 'auto' && apiKey)) {
    if (!apiKey) {
      throw new Error('CODEBUDDY_API_KEY is required for api_key mode');
    }

    return {
      type: 'api_key',
      apiKey,
      userId: 'anonymous',
    };
  }

  const credential = resolveCredentialForRequest();

  if (!credential) {
    throw new Error('No valid CodeBuddy credentials found');
  }

  const bearerToken = String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

  if (!bearerToken) {
    throw new Error('Saved credential does not include a bearer token');
  }

  return {
    type: 'bearer',
    bearerToken,
    userId: String(credential.data.user_id ?? 'unknown'),
    credentialData: credential.data,
  };
};

const getCredentialValue = (
  value: unknown,
  candidateKeys: string[],
): string | number | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = getCredentialValue(item, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }

    return null;
  }

  if (value && typeof value === 'object') {
    for (const key of candidateKeys) {
      const direct = (value as Record<string, unknown>)[key];

      if (direct !== undefined && direct !== null && direct !== '') {
        return direct as string | number;
      }
    }

    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      const nested = getCredentialValue(nestedValue, candidateKeys);

      if (nested !== null && nested !== '') {
        return nested;
      }
    }
  }

  return null;
};

const buildUpstreamHeaders = (
  request: NextRequest,
  auth: ResolvedAuth,
): HeadersInit => {
  const baseUrl = new URL(getCodeBuddyApiEndpoint());
  const incoming = getRequestHeaderMap(request.headers);
  const requestId =
    incoming['x-request-id'] ?? crypto.randomUUID().replaceAll('-', '');
  const conversationId = incoming['x-conversation-id'] ?? crypto.randomUUID();
  const conversationRequestId =
    incoming['x-conversation-request-id'] ??
    crypto.randomUUID().replaceAll('-', '');
  const conversationMessageId =
    incoming['x-conversation-message-id'] ??
    crypto.randomUUID().replaceAll('-', '');
  const headers = new Headers({
    Accept: 'application/json',
    Authorization:
      auth.type === 'api_key'
        ? `Bearer ${auth.apiKey}`
        : `Bearer ${auth.bearerToken}`,
    'Content-Type': 'application/json',
    Host: baseUrl.host,
    'User-Agent': 'CLI/1.0.7 CodeBuddy/1.0.7',
    'X-Agent-Intent': 'craft',
    'X-Conversation-ID': conversationId,
    'X-Conversation-Message-ID': conversationMessageId,
    'X-Conversation-Request-ID': conversationRequestId,
    'X-IDE-Name': 'CLI',
    'X-IDE-Type': 'CLI',
    'X-IDE-Version': '1.0.7',
    'X-Product': 'SaaS',
    'X-Request-ID': requestId,
    'X-Requested-With': 'XMLHttpRequest',
    'X-User-Id': auth.userId,
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'macOS',
    'x-stainless-package-version': '5.10.1',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
  });

  if (auth.type === 'api_key') {
    headers.set('X-API-Key', auth.apiKey);
  }

  if (auth.type === 'bearer') {
    const domain = getCredentialValue(auth.credentialData, ['domain']);
    const enterpriseId = getCredentialValue(auth.credentialData, [
      'enterprise_id',
      'enterpriseId',
    ]);
    const tenantId =
      getCredentialValue(auth.credentialData, ['tenant_id', 'tenantId']) ??
      enterpriseId;

    if (domain) {
      headers.set('X-Domain', String(domain));
    }

    if (enterpriseId) {
      headers.set('X-Enterprise-Id', String(enterpriseId));
    }

    if (tenantId) {
      headers.set('X-Tenant-Id', String(tenantId));
    }
  }

  Object.entries(incoming).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return headers;
};

const buildUpstreamBody = (body: ChatRequestBody): ChatRequestBody => {
  const normalizedMessages = normalizeMessages(body.messages ?? []);
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;

  return {
    model: body.model ?? getAvailableModels()[0] ?? 'glm-5.1',
    messages: normalizedMessages,
    stream: true,
    temperature: body.temperature,
    max_tokens: maxTokens,
    max_completion_tokens: body.max_completion_tokens ?? maxTokens,
    response_format: body.response_format,
    top_p: body.top_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    stop: body.stop,
    tools: body.tools,
    tool_choice: body.tool_choice,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
  };
};

const aggregateToolCalls = (
  toolCalls: NonNullable<ChatStreamDelta['tool_calls']>,
): Array<{
  id?: string;
  type?: string;
  function: {
    arguments: string;
    name: string;
  };
}> => {
  const aggregated = new Map<
    string,
    {
      order: number;
      id?: string;
      type?: string;
      function: {
        arguments: string;
        name: string;
      };
    }
  >();
  const latestKeyByIndex = new Map<number, string>();

  toolCalls.forEach((toolCall, position) => {
    const normalizedId = createNormalizedToolCallId(toolCall.id, position);
    const key =
      (toolCall.id ? `id:${normalizedId}` : undefined) ??
      (typeof toolCall.index === 'number'
        ? latestKeyByIndex.get(toolCall.index)
        : undefined) ??
      `position:${position}`;
    const current = aggregated.get(key) ?? {
      order: aggregated.size,
      function: {
        arguments: '',
        name: '',
      },
    };

    if (toolCall.id) {
      current.id = normalizedId;
    }

    if (toolCall.type) {
      current.type = toolCall.type;
    }

    if (toolCall.function?.name) {
      current.function.name += toolCall.function.name;
    }

    if (toolCall.function?.arguments) {
      current.function.arguments += toolCall.function.arguments;
    }

    aggregated.set(key, current);

    if (typeof toolCall.index === 'number') {
      latestKeyByIndex.set(toolCall.index, key);
    }
  });

  return [...aggregated.values()]
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...value }, index) => ({
      ...value,
      id: value.id ?? createNormalizedToolCallId(undefined, index),
    }));
};

const getToolCallStateKey = (
  toolCall: ToolCallChunk,
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

const createNormalizedToolCallId = (
  sourceId: string | undefined,
  normalizedIndex: number,
): string => {
  if (sourceId && !sourceId.startsWith('tooluse_')) {
    return sourceId;
  }

  const suffix =
    sourceId?.replace(/^tooluse_/, '') ??
    `${normalizedIndex}_${crypto.randomUUID().replaceAll('-', '')}`;

  return `call_${suffix}`;
};

const resolveToolCallMapping = (
  state: ToolCallNormalizationState,
  toolCall: ToolCallChunk,
  position: number,
): ToolCallMapping => {
  const keys = toolCall.id
    ? [`id:${toolCall.id}`]
    : [
        typeof toolCall.index === 'number' ? `index:${toolCall.index}` : null,
        `position:${position}`,
      ].filter((value): value is string => value !== null);
  const existing = keys
    .map((key) => state.mappings.get(key))
    .find((value) => value !== undefined);

  if (existing) {
    return existing;
  }

  return {
    id: createNormalizedToolCallId(toolCall.id, state.nextIndex),
    index: state.nextIndex++,
  };
};

const normalizeStreamToolCalls = (
  chunk: ChatStreamChunk,
  state: ToolCallNormalizationState,
): ChatStreamChunk => {
  if (!chunk.choices?.length) {
    return chunk;
  }

  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      if (!choice.delta?.tool_calls?.length) {
        return choice;
      }

      return {
        ...choice,
        delta: {
          ...choice.delta,
          tool_calls: choice.delta.tool_calls.map((toolCall, position) => {
            const mapping = resolveToolCallMapping(state, toolCall, position);
            const sourceKey = getToolCallStateKey(toolCall, position);

            state.mappings.set(sourceKey, mapping);

            if (toolCall.id) {
              state.mappings.set(`id:${toolCall.id}`, mapping);
            }

            if (typeof toolCall.index === 'number') {
              state.mappings.set(`index:${toolCall.index}`, mapping);
            }

            return {
              ...toolCall,
              id: mapping.id,
              index: mapping.index,
            };
          }),
        },
      };
    }),
  };
};

const normalizeStreamingResponse = (upstreamResponse: Response): Response => {
  if (!upstreamResponse.body) {
    return new Response(null, {
      status: upstreamResponse.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      },
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state: ToolCallNormalizationState = {
    mappings: new Map<string, ToolCallMapping>(),
    nextIndex: 0,
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const reader = upstreamResponse.body!.getReader();
      let buffer = '';

      const processFrame = (frame: string): string => {
        const lines = frame.split('\n');
        const lineIndex = lines.findIndex((line) => line.startsWith('data: '));

        if (lineIndex === -1) {
          return frame;
        }

        const raw = lines[lineIndex]?.slice(6).trim() ?? '';

        if (!raw || raw === '[DONE]') {
          return frame;
        }

        try {
          const chunk = JSON.parse(raw) as ChatStreamChunk;
          const normalized = normalizeStreamToolCalls(chunk, state);
          lines[lineIndex] = `data: ${JSON.stringify(normalized)}`;
          return lines.join('\n');
        } catch {
          return frame;
        }
      };

      const flushFrames = (frames: string[]): void => {
        frames.forEach((frame) => {
          controller.enqueue(encoder.encode(`${processFrame(frame)}\n\n`));
        });
      };

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            flushFrames([buffer]);
          }

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
    status: upstreamResponse.status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

const aggregateUpstreamStream = async (
  upstreamResponse: Response,
  fallbackModel: string,
): Promise<Response> => {
  const payloadText = await upstreamResponse.text();
  const toolCalls: NonNullable<ChatStreamDelta['tool_calls']> = [];
  let responseId = '';
  let responseObject = 'chat.completion';
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let content = '';
  let reasoningContent = '';
  let finishReason: string | null = 'stop';
  let role = 'assistant';
  let usage: unknown = null;

  for (const frame of payloadText.split('\n\n')) {
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

    let chunk: ChatStreamChunk;

    try {
      chunk = JSON.parse(raw) as ChatStreamChunk;
    } catch {
      return createErrorResponse(502, 'Failed to parse upstream SSE frame');
    }

    if (chunk.id) {
      responseId = chunk.id;
    }

    if (chunk.object) {
      responseObject = chunk.object.replace(/\.chunk$/, '');
    }

    if (typeof chunk.created === 'number') {
      created = chunk.created;
    }

    if (chunk.model) {
      model = chunk.model;
    }

    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (delta?.role) {
      role = delta.role;
    }

    if (delta?.content) {
      content += delta.content;
    }

    if (delta?.reasoning_content ?? delta?.reasoning) {
      reasoningContent += delta.reasoning_content ?? delta.reasoning;
    }

    if (delta?.tool_calls?.length) {
      toolCalls.push(...delta.tool_calls);
    }

    if (choice?.finish_reason !== undefined) {
      finishReason = choice.finish_reason ?? finishReason;
    }
  }

  const aggregatedToolCalls = aggregateToolCalls(toolCalls);
  const message: Record<string, unknown> = {
    role,
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (aggregatedToolCalls.length) {
    message.tool_calls = aggregatedToolCalls;
  }

  return Response.json({
    id: responseId || `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`,
    object: responseObject,
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          finishReason ?? (aggregatedToolCalls.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage,
  });
};

export const getModelsResponse = (): Response => {
  return Response.json({
    object: 'list',
    data: getAvailableModels().map((model) => ({
      id: model,
      object: 'model',
      created: 0,
      owned_by: 'codebuddy',
    })),
  });
};

export const proxyChatCompletions = async (
  request: NextRequest,
  body: ChatRequestBody,
): Promise<Response> => {
  if (!body.messages?.length) {
    return createErrorResponse(400, 'messages is required');
  }

  try {
    const auth = getResolvedAuth();
    const upstreamBody = buildUpstreamBody(body);
    const upstreamResponse = await fetch(
      `${getCodeBuddyApiEndpoint()}/v2/chat/completions`,
      {
        method: 'POST',
        headers: buildUpstreamHeaders(request, auth),
        body: JSON.stringify(upstreamBody),
        cache: 'no-store',
      },
    );

    recordModelUsage(String(upstreamBody.model ?? 'unknown'));

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text();
      return createErrorResponse(
        upstreamResponse.status,
        'Upstream CodeBuddy request failed',
        detail,
      );
    }

    if (body.stream) {
      return normalizeStreamingResponse(upstreamResponse);
    }

    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      return new Response(await upstreamResponse.text(), {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    return aggregateUpstreamStream(
      upstreamResponse,
      String(upstreamBody.model ?? 'unknown'),
    );
  } catch (error) {
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};
