import type { NextRequest } from 'next/server';

import { resolveRequestAccessKey } from './auth';
import {
  getAvailableModels,
  getCodeBuddyApiEndpoint,
  getDefaultModel,
} from '../domain/config';
import {
  type CredentialRecord,
  findEligibleCredentialRecordByFilename,
  findCredentialRecordByFilename,
  getCredentialProxySettings,
  resolveCredentialForRequest,
} from '../domain/credentials';
import {
  enqueueUpstreamResponseSnapshot,
  setDebugTraceCredential,
  setDebugTraceError,
  setDebugUpstreamRequest,
  type DebugTrace,
} from '../domain/debug';
import { createErrorResponse, getRequestHeaderMap } from '../shared/http';
import { recordUsageEvent, type UsageSnapshot } from '../domain/usage';

interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface CacheableTextBlock {
  cache_control?: { type: 'ephemeral' };
  text: string;
  type: 'text';
}

const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;

export interface ChatRequestBody {
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

interface ResolvedAuth {
  type: 'bearer';
  bearerToken: string;
  userId: string;
  credentialData: Record<string, unknown>;
}

export interface ProxyContext {
  accessKeyId: string | null;
  accessKeyName: string | null;
  auth: ResolvedAuth;
  credentialFilename: string | null;
  preferences: {
    firstMessageRoleToSystem: boolean;
    responsesPassthrough: boolean;
  };
}

const getCredentialAffinityKey = (
  request: NextRequest,
  accessKeyId: string | null,
): string | undefined => {
  const incoming = getRequestHeaderMap(request.headers);
  const conversationId = incoming['x-conversation-id']?.trim();

  if (!conversationId) {
    return undefined;
  }

  if (accessKeyId) {
    return `access-key:${accessKeyId}:conversation:${conversationId}`;
  }

  return `global:conversation:${conversationId}`;
};

const toUsageSnapshot = (usage: unknown): UsageSnapshot | null => {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  return usage as UsageSnapshot;
};

const recordProxyUsage = async ({
  model,
  proxyContext,
  route,
  usage,
}: {
  model: string;
  proxyContext: ProxyContext;
  route: string;
  usage: unknown;
}): Promise<void> => {
  await recordUsageEvent({
    accessKeyId: proxyContext.accessKeyId,
    accessKeyName: proxyContext.accessKeyName,
    credentialFilename: proxyContext.credentialFilename,
    model,
    route,
    usage: toUsageSnapshot(usage) ?? {},
  });
};

const extractResponsesUsage = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const payload = value as {
    response?: {
      usage?: unknown;
    };
    usage?: unknown;
  };

  return payload.response?.usage ?? payload.usage ?? null;
};

const parseUsageHeader = (response: Response): unknown => {
  const usageHeader = response.headers.get('x-codebuddy-usage');

  if (!usageHeader) {
    return null;
  }

  try {
    return JSON.parse(usageHeader) as unknown;
  } catch {
    return null;
  }
};

const trackResponsesUsageStream = async ({
  fallbackUsage,
  model,
  proxyContext,
  upstreamResponse,
}: {
  fallbackUsage: unknown;
  model: string;
  proxyContext: ProxyContext;
  upstreamResponse: Response;
}): Promise<Response> => {
  if (!upstreamResponse.body) {
    await recordProxyUsage({
      model,
      proxyContext,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(null, {
      headers: upstreamResponse.headers,
      status: upstreamResponse.status,
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const reader = upstreamResponse.body!.getReader();
      let buffer = '';
      let latestUsage = fallbackUsage;

      const inspectFrame = (frame: string): void => {
        frame.split('\n').forEach((line) => {
          if (!line.startsWith('data:')) {
            return;
          }

          const raw = line.slice(5).trim();

          if (!raw || raw === '[DONE]') {
            return;
          }

          try {
            latestUsage =
              extractResponsesUsage(JSON.parse(raw) as unknown) ?? latestUsage;
          } catch {
            // Preserve malformed upstream frames without recording them.
          }
        });
      };

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer) {
            inspectFrame(buffer);
            controller.enqueue(encoder.encode(buffer));
          }

          await recordProxyUsage({
            model,
            proxyContext,
            route: '/v1/responses',
            usage: latestUsage,
          });
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });
        buffer += text;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        frames.forEach((frame) => {
          inspectFrame(frame);
          controller.enqueue(encoder.encode(`${frame}\n\n`));
        });

        await pump();
      };

      void pump();
    },
  });

  return new Response(stream, {
    headers: upstreamResponse.headers,
    status: upstreamResponse.status,
  });
};

const logUpstreamFailure = ({
  detail,
  error,
  route,
  status,
  url,
}: {
  detail?: string;
  error?: unknown;
  route: string;
  status?: number;
  url: string;
}): void => {
  const payload: Record<string, unknown> = {
    route,
    url,
  };

  if (typeof status === 'number') {
    payload.status = status;
  }

  if (detail) {
    payload.detail = detail.slice(0, 1000);
  }

  if (error) {
    payload.error = error;
  }

  console.error('[CodeBuddy2API] Upstream request failed', payload);
};

const hasPromptCacheControl = (content: unknown): boolean => {
  return (
    Array.isArray(content) &&
    content.some(
      (part) => !!part && typeof part === 'object' && 'cache_control' in part,
    )
  );
};

const createCacheableTextBlock = (text: string): CacheableTextBlock => ({
  type: 'text',
  text,
  cache_control: { type: 'ephemeral' },
});

const addPromptCacheControl = (message: OpenAIMessage): OpenAIMessage => {
  if (
    typeof message.content === 'string' &&
    message.content.trim().length >= MIN_AUTO_CACHE_TEXT_LENGTH
  ) {
    return {
      ...message,
      content: [createCacheableTextBlock(message.content)],
    };
  }

  if (Array.isArray(message.content)) {
    const textIndex = message.content.findIndex(
      (part) =>
        !!part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        (part as { text: string }).text.trim().length >=
          MIN_AUTO_CACHE_TEXT_LENGTH,
    );

    if (textIndex >= 0) {
      return {
        ...message,
        content: message.content.map((part, index) =>
          index === textIndex && part && typeof part === 'object'
            ? {
                ...part,
                cache_control: { type: 'ephemeral' },
              }
            : part,
        ),
      };
    }
  }

  return message;
};

const applyPromptCacheControl = (
  messages: OpenAIMessage[],
): OpenAIMessage[] => {
  const explicitCacheControl = messages.some((message) =>
    hasPromptCacheControl(message.content),
  );

  if (explicitCacheControl) {
    return messages;
  }

  const cacheableIndexes = new Set<number>();
  const systemIndex = messages.findIndex(
    (message) => message.role === 'system',
  );

  if (systemIndex >= 0) {
    cacheableIndexes.add(systemIndex);
  }

  let lastUserIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex >= 0) {
    cacheableIndexes.add(lastUserIndex);
  }

  if (cacheableIndexes.size === 0) {
    return messages;
  }

  return messages.map((message, index) =>
    cacheableIndexes.has(index) ? addPromptCacheControl(message) : message,
  );
};

const normalizeMessages = (
  messages: OpenAIMessage[],
  firstMessageRoleToSystem: boolean,
): OpenAIMessage[] => {
  const filtered = messages.filter(
    (item) => item.role && item.content !== undefined,
  );

  if (!firstMessageRoleToSystem) {
    return applyPromptCacheControl(filtered);
  }

  let hasSystemMessage = false;

  const normalized = filtered.map((message, index) => {
    if (message.role === 'system') {
      hasSystemMessage = true;
      return message;
    }

    if (message.role !== 'developer') {
      return message;
    }

    if (index === 0 && !hasSystemMessage) {
      hasSystemMessage = true;
      return {
        ...message,
        role: 'system',
      };
    }

    return {
      ...message,
      role: 'user',
    };
  });

  // Preserve role:'tool' messages so the OpenAI-compatible upstream
  // receives a valid tool_calls/tool-result pair for multi-step tool loops.
  return applyPromptCacheControl(normalized);
};

export const resolveProxyContext = async (
  request: NextRequest,
): Promise<ProxyContext> => {
  const accessKey = await resolveRequestAccessKey(request);
  const credential = await resolveCredentialForRequest({
    accessKeyId: accessKey?.id,
    affinityKey: getCredentialAffinityKey(request, accessKey?.id ?? null),
    allowedCredentialFilenames: accessKey?.credentialFilenames,
  });

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
    accessKeyId: accessKey?.id ?? null,
    accessKeyName: accessKey?.name ?? null,
    auth: {
      type: 'bearer',
      bearerToken,
      userId: String(credential.data.user_id ?? 'unknown'),
      credentialData: credential.data,
    },
    credentialFilename: credential.filename,
    preferences: getCredentialProxySettings(credential.data),
  };
};

export const createProxyContextFromCredential = (
  credential: CredentialRecord,
): ProxyContext => {
  const bearerToken = String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

  if (!bearerToken) {
    throw new Error('Saved credential does not include a bearer token');
  }

  return {
    accessKeyId: null,
    accessKeyName: null,
    auth: {
      type: 'bearer',
      bearerToken,
      userId: String(credential.data.user_id ?? 'unknown'),
      credentialData: credential.data,
    },
    credentialFilename: credential.filename,
    preferences: getCredentialProxySettings(credential.data),
  };
};

export const resolveProxyContextByCredentialFilename = async (
  filename: string,
  options?: {
    accessKey?: {
      id?: string | null;
      name?: string | null;
    };
    allowedCredentialFilenames?: string[];
    requireEligible?: boolean;
  },
): Promise<ProxyContext> => {
  const credential = options?.requireEligible
    ? await findEligibleCredentialRecordByFilename(
        filename,
        options.allowedCredentialFilenames,
      )
    : await findCredentialRecordByFilename(filename);

  if (!credential) {
    throw new Error('Selected credential was not found');
  }

  return {
    ...createProxyContextFromCredential(credential),
    accessKeyId: options?.accessKey?.id ?? null,
    accessKeyName: options?.accessKey?.name ?? null,
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

const buildUpstreamHeaders = async (
  request: NextRequest,
  auth: ResolvedAuth,
): Promise<HeadersInit> => {
  const baseUrl = new URL(await getCodeBuddyApiEndpoint());
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
    Authorization: `Bearer ${auth.bearerToken}`,
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

  for (const [name, value] of Object.entries(incoming)) {
    headers.set(name, value);
  }

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

  return headers;
};

const headersToRecord = (headers: HeadersInit): Record<string, string> => {
  return Object.fromEntries(new Headers(headers).entries());
};

const buildUpstreamBody = async (
  body: ChatRequestBody,
  context: ProxyContext,
): Promise<ChatRequestBody> => {
  const normalizedMessages = normalizeMessages(
    body.messages ?? [],
    context.preferences.firstMessageRoleToSystem,
  );
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model
      : await getDefaultModel();

  return {
    model,
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

const normalizeStreamingResponse = ({
  model,
  proxyContext,
  route,
  upstreamResponse,
}: {
  model: string;
  proxyContext: ProxyContext;
  route: string;
  upstreamResponse: Response;
}): Response => {
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
      let latestUsage: unknown = null;

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
          if (chunk.usage !== undefined) {
            latestUsage = chunk.usage;
          }
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

          await recordProxyUsage({
            model,
            proxyContext,
            route,
            usage: latestUsage,
          });

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
): Promise<{ model: string; response: Response; usage: unknown }> => {
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
      return {
        model: fallbackModel,
        response: createErrorResponse(
          502,
          'Failed to parse upstream SSE frame',
        ),
        usage: null,
      };
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

  return {
    model,
    response: Response.json({
      id: responseId || `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`,
      object: responseObject,
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason:
            finishReason ??
            (aggregatedToolCalls.length ? 'tool_calls' : 'stop'),
        },
      ],
      usage,
    }),
    usage,
  };
};

export const getModelsResponse = async (): Promise<Response> => {
  const models = (await getAvailableModels()).map((model) => ({
    id: model,
    slug: model,
    display_name: model,
    object: 'model',
    created: 0,
    owned_by: 'codebuddy',
  }));

  return Response.json({
    object: 'list',
    data: models,
    models,
  });
};

export const proxyChatCompletions = async (
  request: NextRequest,
  body: ChatRequestBody,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  usageRoute = '/v1/chat/completions',
): Promise<Response> => {
  if (!body.messages?.length) {
    return createErrorResponse(400, 'messages is required');
  }

  try {
    const resolvedContext = context ?? (await resolveProxyContext(request));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = await buildUpstreamBody(body, resolvedContext);
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/v2/chat/completions`;
    const upstreamHeaders = await buildUpstreamHeaders(
      request,
      resolvedContext.auth,
    );

    setDebugUpstreamRequest(debugTrace, {
      body: upstreamBody,
      headers: headersToRecord(upstreamHeaders),
      method: 'POST',
      url: upstreamUrl,
    });

    let upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      cache: 'no-store',
    });

    upstreamResponse = enqueueUpstreamResponseSnapshot(
      debugTrace,
      upstreamResponse,
    );

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text();
      logUpstreamFailure({
        detail,
        route: '/v1/chat/completions',
        status: upstreamResponse.status,
        url: upstreamUrl,
      });
      setDebugTraceError(debugTrace, detail);
      return createErrorResponse(
        upstreamResponse.status,
        'Upstream CodeBuddy request failed',
        detail,
      );
    }

    if (body.stream) {
      return normalizeStreamingResponse({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        upstreamResponse,
      });
    }

    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage: unknown = null;

      try {
        usage = (JSON.parse(payloadText) as { usage?: unknown }).usage ?? null;
      } catch {
        usage = null;
      }

      await recordProxyUsage({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        usage,
      });

      return new Response(payloadText, {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const aggregated = await aggregateUpstreamStream(
      upstreamResponse,
      String(upstreamBody.model ?? 'unknown'),
    );

    await recordProxyUsage({
      model: aggregated.model,
      proxyContext: resolvedContext,
      route: usageRoute,
      usage: aggregated.usage,
    });

    return aggregated.response;
  } catch (error) {
    setDebugTraceError(debugTrace, error);
    logUpstreamFailure({
      error,
      route: '/v1/chat/completions',
      url: `${await getCodeBuddyApiEndpoint()}/v2/chat/completions`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};

export const proxyResponsesUpstream = async (
  request: NextRequest,
  body: Record<string, unknown>,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  try {
    const resolvedContext = context ?? (await resolveProxyContext(request));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = {
      ...body,
      model:
        typeof body.model === 'string' && body.model.trim()
          ? body.model
          : await getDefaultModel(),
    };
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/v1/responses`;
    const upstreamHeaders = await buildUpstreamHeaders(
      request,
      resolvedContext.auth,
    );

    setDebugUpstreamRequest(debugTrace, {
      body: upstreamBody,
      headers: headersToRecord(upstreamHeaders),
      method: 'POST',
      url: upstreamUrl,
    });

    let upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      cache: 'no-store',
    });

    upstreamResponse = enqueueUpstreamResponseSnapshot(
      debugTrace,
      upstreamResponse,
    );

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text();
      logUpstreamFailure({
        detail,
        route: '/v1/responses',
        status: upstreamResponse.status,
        url: upstreamUrl,
      });
      setDebugTraceError(debugTrace, detail);
      return createErrorResponse(
        upstreamResponse.status,
        'Upstream CodeBuddy request failed',
        detail,
      );
    }

    const model = String(upstreamBody.model ?? 'unknown');
    const fallbackUsage = parseUsageHeader(upstreamResponse);
    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage = fallbackUsage;

      try {
        usage =
          extractResponsesUsage(JSON.parse(payloadText) as unknown) ??
          fallbackUsage;
      } catch {
        // Preserve malformed upstream JSON while retaining header usage.
      }

      await recordProxyUsage({
        model,
        proxyContext: resolvedContext,
        route: '/v1/responses',
        usage,
      });

      return new Response(payloadText, {
        headers: upstreamResponse.headers,
        status: upstreamResponse.status,
      });
    }

    if (contentType.toLowerCase().includes('text/event-stream')) {
      return trackResponsesUsageStream({
        fallbackUsage,
        model,
        proxyContext: resolvedContext,
        upstreamResponse,
      });
    }

    await recordProxyUsage({
      model,
      proxyContext: resolvedContext,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  } catch (error) {
    setDebugTraceError(debugTrace, error);
    logUpstreamFailure({
      error,
      route: '/v1/responses',
      url: `${await getCodeBuddyApiEndpoint()}/v1/responses`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};
