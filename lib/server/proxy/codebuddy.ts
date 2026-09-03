import type { NextRequest } from 'next/server';

import { resolveRequestAccessKey } from './auth';
import { getCodeBuddyApiEndpoint, getDefaultModel } from '../domain/config';
import {
  type CredentialData,
  type CredentialRecord,
  findEligibleCredentialRecordByFilename,
  findCredentialRecordByFilename,
  getCredentialSupportedModels,
  getCredentialProxySettings,
  listEligibleCredentialRecords,
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
const MAX_STREAM_FRAME_LENGTH = 1_000_000;
const CODEBUDDY_CLI_VERSION = '2.137.1';
const CODEBUDDY_USER_AGENT = `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`;

export interface ChatRequestBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
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
  parallel_tool_calls?: boolean;
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
    firstSystemMessageRoleToUser: boolean;
    upstreamProtocol: 'chat' | 'responses';
  };
}

export interface DiscoveredModel {
  displayName: string;
  id: string;
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

const mapResponsesUsageToChat = (
  usage: unknown,
): Record<string, unknown> | null => {
  if (!usage || typeof usage !== 'object') return null;

  const value = usage as {
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    input_tokens?: unknown;
    input_tokens_details?: {
      cache_creation_tokens?: unknown;
      cached_tokens?: unknown;
    };
    output_tokens?: unknown;
    output_tokens_details?: {
      reasoning_tokens?: unknown;
    };
    total_tokens?: unknown;
  };
  const inputTokens = Number(value.input_tokens ?? 0);
  const outputTokens = Number(value.output_tokens ?? 0);
  const cachedTokens = Number(
    value.input_tokens_details?.cached_tokens ??
      value.cache_read_input_tokens ??
      0,
  );
  const cacheCreationTokens = Number(
    value.input_tokens_details?.cache_creation_tokens ??
      value.cache_creation_input_tokens ??
      0,
  );
  const reasoningTokens = Number(
    value.output_tokens_details?.reasoning_tokens ?? 0,
  );

  return {
    completion_tokens: outputTokens,
    completion_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
    prompt_tokens: inputTokens,
    prompt_tokens_details: {
      cache_creation_tokens: cacheCreationTokens,
      cached_tokens: cachedTokens,
    },
    total_tokens: Number(value.total_tokens ?? inputTokens + outputTokens),
  };
};

const extractResponsesId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    id?: unknown;
    response?: { id?: unknown };
  };
  const id = payload.response?.id ?? payload.id;
  return typeof id === 'string' && id ? id : null;
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
  onResponseId,
  proxyContext,
  upstreamResponse,
}: {
  fallbackUsage: unknown;
  model: string;
  onResponseId?: (responseId: string) => Promise<void>;
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let latestUsage = fallbackUsage;
  let responseBinding: Promise<void> | null = null;
  let usageRecorded = false;
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };
  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route: '/v1/responses',
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route: '/v1/responses',
      });
    }
  };
  const bindResponseId = (id: string): Promise<void> => {
    if (!onResponseId) return Promise.resolve();
    responseBinding ??= onResponseId(id).catch((error) => {
      console.error(
        '[CodeBuddy2API] Failed to bind upstream Responses session',
        {
          error,
          responseId: id,
        },
      );
    });
    return responseBinding;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let responseId: string | null = null;

      const inspectFrame = async (frame: string): Promise<void> => {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const raw = line.slice(5).trim();

          if (!raw || raw === '[DONE]') {
            continue;
          }

          try {
            const event = JSON.parse(raw) as unknown;
            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            responseId = extractResponsesId(event) ?? responseId;
            if (responseId) await bindResponseId(responseId);
          } catch {
            // Preserve malformed upstream frames without recording them.
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
            if (buffer) {
              await inspectFrame(buffer);
              controller.enqueue(encoder.encode(buffer));
            }

            await recordStreamUsage();
            await responseBinding;
            releaseReader();
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          buffer += text;
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            buffer = '';
          }

          for (const frame of frames) {
            if (frame.length > MAX_STREAM_FRAME_LENGTH) {
              continue;
            }
            await inspectFrame(frame);
            if (cancelled) return;
            controller.enqueue(encoder.encode(`${frame}\n\n`));
          }
        }
      };

      void pump().catch(async (error) => {
        if (cancelled) return;
        console.error('[CodeBuddy2API] Responses upstream stream failed', {
          error,
          route: '/v1/responses',
        });
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
        controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await reader?.cancel(reason);
      } finally {
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
      }
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
  firstSystemMessageRoleToUser: boolean,
): OpenAIMessage[] => {
  const filtered = messages.filter(
    (item) => item.role && item.content !== undefined,
  );

  const firstSystemIndex = firstSystemMessageRoleToUser
    ? filtered.findIndex((message) => message.role === 'system')
    : -1;
  const normalized = filtered.map((message, index) => {
    if (
      (firstMessageRoleToSystem && message.role === 'developer') ||
      index === firstSystemIndex
    ) {
      return { ...message, role: 'user' };
    }

    return message;
  });

  // Preserve role:'tool' messages so the OpenAI-compatible upstream
  // receives a valid tool_calls/tool-result pair for multi-step tool loops.
  return applyPromptCacheControl(normalized);
};

export const resolveProxyContext = async (
  request: NextRequest,
  model?: string,
): Promise<ProxyContext> => {
  const accessKey = await resolveRequestAccessKey(request);
  const credential = await resolveCredentialForRequest({
    accessKeyId: accessKey?.id,
    affinityKey: getCredentialAffinityKey(request, accessKey?.id ?? null),
    allowedCredentialFilenames: accessKey?.credentialFilenames,
    model,
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
  const headers = new Headers(incoming);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${auth.bearerToken}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Host', baseUrl.host);
  headers.set('User-Agent', CODEBUDDY_USER_AGENT);
  headers.set('X-Agent-Intent', 'craft');
  headers.set('X-Conversation-ID', conversationId);
  headers.set('X-Conversation-Message-ID', conversationMessageId);
  headers.set('X-Conversation-Request-ID', conversationRequestId);
  headers.set('X-IDE-Name', 'CLI');
  headers.set('X-IDE-Type', 'CLI');
  headers.set('X-IDE-Version', CODEBUDDY_CLI_VERSION);
  headers.set('X-Client-Platform', 'web');
  headers.set('X-Product', 'SaaS');
  headers.set('X-Product-Version', CODEBUDDY_CLI_VERSION);
  headers.set('X-Request-ID', requestId);
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('X-User-Id', auth.userId);
  headers.set('x-stainless-arch', process.arch);
  headers.set('x-stainless-lang', 'js');
  headers.set('x-stainless-os', process.platform);
  headers.set('x-stainless-package-version', CODEBUDDY_CLI_VERSION);
  headers.set('x-stainless-retry-count', '0');
  headers.set('x-stainless-runtime', 'node');
  headers.set('x-stainless-runtime-version', process.version);

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

  const origin = String(domain ?? '')
    .toLowerCase()
    .endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : 'https://www.codebuddy.cn';
  headers.set('Content-Type', 'application/json');
  headers.set('Origin', origin);
  headers.set('Referer', `${origin}/`);
  headers.set('User-Agent', CODEBUDDY_USER_AGENT);
  headers.set('X-Product', 'SaaS');
  headers.set('X-Requested-With', 'XMLHttpRequest');
  headers.set('X-IDE-Name', 'CLI');
  headers.set('X-IDE-Type', 'CLI');
  headers.set('X-IDE-Version', CODEBUDDY_CLI_VERSION);

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
    context.preferences.firstSystemMessageRoleToUser,
  );
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  const credentialModels = getCredentialSupportedModels(
    context.auth.credentialData,
  );
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model
      : (credentialModels[0] ?? (await getDefaultModel()));

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
    stream_options: body.stream_options,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    thinking: body.thinking,
    reasoning_effort: body.reasoning_effort,
  };
};

const stringifyResponsesInputContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return JSON.stringify(part);
      })
      .join('');
  }
  return JSON.stringify(content);
};

const mapChatContentToResponses = (
  content: unknown,
): Array<Record<string, unknown>> => {
  if (!Array.isArray(content)) {
    return [
      {
        text: stringifyResponsesInputContent(content),
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

const translateChatToolChoiceToResponses = (toolChoice: unknown): unknown => {
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

const translateChatResponseFormatToResponses = (
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

const translateChatThinkingToResponses = (
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

const normalizeStopSequences = (
  stop: string | string[] | undefined,
): string[] => {
  return (Array.isArray(stop) ? stop : stop ? [stop] : []).filter(Boolean);
};

const findFirstStopSequence = (
  text: string,
  stopSequences: string[],
): number | null => {
  return stopSequences.reduce<number | null>((earliest, stopSequence) => {
    const index = text.indexOf(stopSequence);
    if (index < 0) return earliest;
    return earliest === null ? index : Math.min(earliest, index);
  }, null);
};

const getPendingStopPrefixLength = (
  text: string,
  stopSequences: string[],
): number => {
  const maximumLength = Math.min(
    text.length,
    Math.max(
      0,
      ...stopSequences.map((stopSequence) => stopSequence.length - 1),
    ),
  );

  for (let length = maximumLength; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (stopSequences.some((stopSequence) => stopSequence.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
};

const normalizeResponsesUpstreamBody = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const { messages, ...rest } = body;

  if (rest.input !== undefined || !Array.isArray(messages)) {
    return rest;
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
      return stringifyResponsesInputContent(
        (message as { content?: unknown }).content,
      );
    })
    .filter(Boolean)
    .join('\n\n');
  const input = messages.flatMap((message) => {
    if (!message || typeof message !== 'object') return [];
    const value = message as { content?: unknown; role?: unknown };
    if (value.role === 'system' || value.role === 'developer') return [];
    const role = value.role === 'assistant' ? 'assistant' : 'user';
    return [
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

  return { ...rest, ...(instructions ? { instructions } : {}), input };
};

const buildResponsesBodyFromChat = (
  body: ChatRequestBody,
): Record<string, unknown> => {
  const instructions = body.messages
    ?.filter(
      (message) => message.role === 'system' || message.role === 'developer',
    )
    .map((message) => stringifyResponsesInputContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input =
    body.messages
      ?.filter(
        (message) => message.role !== 'system' && message.role !== 'developer',
      )
      .map((message) => {
        if (message.role === 'tool') {
          return {
            call_id: message.tool_call_id,
            output: stringifyResponsesInputContent(message.content),
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
  const reasoning = translateChatThinkingToResponses(
    body.thinking,
    body.reasoning_effort,
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

const getUnsupportedResponsesChatOptions = (
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

const extractResponsesReasoningText = (output: unknown[]): string => {
  return output
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as {
        content?: unknown;
        summary?: unknown;
        type?: unknown;
      };
      if (value.type !== 'reasoning') return [];
      return [value.summary, value.content].flatMap((parts) => {
        if (!Array.isArray(parts)) return [];
        return parts.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? [text] : [];
        });
      });
    })
    .join('');
};

const mapResponsesPayloadToChat = (
  payload: Record<string, unknown>,
  model: string,
  stop: string | string[] | undefined,
): Record<string, unknown> => {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const toolCalls = output.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    if (value.type !== 'function_call') return [];
    return [
      {
        function: {
          arguments: String(value.arguments ?? ''),
          name: String(value.name ?? 'function'),
        },
        id: String(value.call_id ?? value.id ?? crypto.randomUUID()),
        type: 'function',
      },
    ];
  });
  const usage =
    payload.usage && typeof payload.usage === 'object'
      ? (payload.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = Number(usage?.input_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? 0);

  const rawOutputText =
    typeof payload.output_text === 'string'
      ? payload.output_text
      : output
          .flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const content = (item as { content?: unknown }).content;
            if (!Array.isArray(content)) return [];
            return content.flatMap((part) => {
              if (!part || typeof part !== 'object') return [];
              const value = part as { text?: unknown; type?: unknown };
              return value.type === 'output_text' &&
                typeof value.text === 'string'
                ? [value.text]
                : [];
            });
          })
          .join('');
  const stopIndex = findFirstStopSequence(
    rawOutputText,
    normalizeStopSequences(stop),
  );
  const outputText =
    stopIndex === null ? rawOutputText : rawOutputText.slice(0, stopIndex);
  const reasoningText = extractResponsesReasoningText(output);
  const incompleteReason =
    payload.incomplete_details && typeof payload.incomplete_details === 'object'
      ? (payload.incomplete_details as { reason?: unknown }).reason
      : undefined;
  const finishReason =
    payload.status === 'incomplete'
      ? incompleteReason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : toolCalls.length
        ? 'tool_calls'
        : 'stop';

  return {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        message: {
          content: outputText || null,
          role: 'assistant',
          ...(reasoningText ? { reasoning_content: reasoningText } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    created: Number(payload.created_at ?? Math.floor(Date.now() / 1000)),
    id: String(payload.id ?? `chatcmpl-${crypto.randomUUID()}`),
    model,
    object: 'chat.completion',
    usage: {
      completion_tokens: outputTokens,
      prompt_tokens: inputTokens,
      total_tokens: Number(usage?.total_tokens ?? inputTokens + outputTokens),
    },
  };
};

const mapResponsesStreamToChat = (
  upstreamResponse: Response,
  model: string,
  proxyContext: ProxyContext,
  route: string,
  stop: string | string[] | undefined,
  includeUsage: boolean,
): Response => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null =
    upstreamResponse.body?.getReader() ?? null;
  const fallbackUsage = parseUsageHeader(upstreamResponse);
  let buffer = '';
  let emittedFinish = false;
  let emittedUsage = false;
  let hasToolCalls = false;
  let latestUsage = fallbackUsage;
  let usageRecorded = false;
  const stopSequences = normalizeStopSequences(stop);
  let pendingStopText = '';
  const toolIndexes = new Map<string, number>();
  const toolCallIds = new Map<string, string>();
  let nextToolIndex = 0;
  let stoppedLocally = false;

  const getToolIndex = (itemId: string): number => {
    const existing = toolIndexes.get(itemId);
    if (existing !== undefined) return existing;
    const index = nextToolIndex;
    nextToolIndex += 1;
    toolIndexes.set(itemId, index);
    return index;
  };

  const encodeChunk = (choice: Record<string, unknown>): Uint8Array => {
    return encoder.encode(
      `data: ${JSON.stringify({
        choices: [choice],
        created: Math.floor(Date.now() / 1000),
        id: responseId,
        model,
        object: 'chat.completion.chunk',
      })}\n\n`,
    );
  };

  const enqueueUsage = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (!includeUsage || emittedUsage) return;
    const usage = mapResponsesUsageToChat(latestUsage);
    if (!usage) return;

    emittedUsage = true;
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({
          choices: [],
          created: Math.floor(Date.now() / 1000),
          id: responseId,
          model,
          object: 'chat.completion.chunk',
          usage,
        })}\n\n`,
      ),
    );
  };

  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route,
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route,
      });
    }
  };

  const cancelAndReleaseReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader?.cancel(reason);
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to cancel Responses stream', {
        error,
        route,
      });
    } finally {
      reader?.releaseLock();
      reader = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        await recordStreamUsage();
        controller.close();
        return;
      }
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          await recordStreamUsage();
          reader.releaseLock();
          reader = null;
          controller.error(error);
          return;
        }
        const { done, value } = readResult;
        if (done) {
          if (pendingStopText) {
            controller.enqueue(
              encodeChunk({
                delta: { content: pendingStopText },
                index: 0,
              }),
            );
            pendingStopText = '';
          }
          if (!emittedFinish) {
            controller.enqueue(
              encodeChunk({
                delta: {},
                finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                index: 0,
              }),
            );
          }
          enqueueUsage(controller);
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          await recordStreamUsage();
          reader.releaseLock();
          reader = null;
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
          controller.enqueue(
            encoder.encode(
              'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
            ),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          await cancelAndReleaseReader();
          await recordStreamUsage();
          controller.close();
          return;
        }
        let emitted = false;
        for (const frame of frames) {
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            await cancelAndReleaseReader();
            await recordStreamUsage();
            controller.close();
            return;
          }
          const dataLine = frame
            .split(/\r?\n/)
            .find((line) => line.startsWith('data: '));
          if (!dataLine || dataLine === 'data: [DONE]') continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              delta?: unknown;
              item?: unknown;
              item_id?: unknown;
              output_index?: unknown;
              error?: unknown;
              response?: unknown;
              type?: unknown;
            };
            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            if (
              stoppedLocally &&
              event.type !== 'response.completed' &&
              event.type !== 'response.incomplete'
            ) {
              continue;
            }
            if (event.type === 'response.output_text.delta') {
              const delta = String(event.delta ?? '');
              if (stopSequences.length) {
                pendingStopText += delta;
                const stopIndex = findFirstStopSequence(
                  pendingStopText,
                  stopSequences,
                );
                if (stopIndex !== null) {
                  const content = pendingStopText.slice(0, stopIndex);
                  if (content) {
                    controller.enqueue(
                      encodeChunk({ delta: { content }, index: 0 }),
                    );
                  }
                  pendingStopText = '';
                  controller.enqueue(
                    encodeChunk({
                      delta: {},
                      finish_reason: 'stop',
                      index: 0,
                    }),
                  );
                  emittedFinish = true;
                  stoppedLocally = true;
                  emitted = true;
                  continue;
                }

                const pendingLength = getPendingStopPrefixLength(
                  pendingStopText,
                  stopSequences,
                );
                const content = pendingStopText.slice(
                  0,
                  pendingStopText.length - pendingLength,
                );
                pendingStopText = pendingLength
                  ? pendingStopText.slice(-pendingLength)
                  : '';
                if (!content) continue;
                controller.enqueue(
                  encodeChunk({ delta: { content }, index: 0 }),
                );
                emitted = true;
                continue;
              }
              controller.enqueue(
                encodeChunk({
                  delta: { content: delta },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.reasoning_summary_text.delta' ||
              event.type === 'response.reasoning_text.delta'
            ) {
              controller.enqueue(
                encodeChunk({
                  delta: { reasoning_content: String(event.delta ?? '') },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (
              event.type === 'response.output_item.added' &&
              event.item &&
              typeof event.item === 'object'
            ) {
              const item = event.item as {
                arguments?: unknown;
                call_id?: unknown;
                id?: unknown;
                name?: unknown;
                type?: unknown;
              };
              if (item.type !== 'function_call') continue;
              const itemId = String(item.id ?? item.call_id ?? nextToolIndex);
              const index = getToolIndex(itemId);
              const callId = String(item.call_id ?? item.id ?? itemId);
              toolCallIds.set(itemId, callId);
              hasToolCalls = true;
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: String(item.arguments ?? ''),
                          name: String(item.name ?? 'function'),
                        },
                        id: callId,
                        index,
                        type: 'function',
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (event.type === 'response.function_call_arguments.delta') {
              const itemId = String(
                event.item_id ?? event.output_index ?? nextToolIndex,
              );
              const index = getToolIndex(itemId);
              const callId = toolCallIds.get(itemId) ?? `call_${index + 1}`;
              toolCallIds.set(itemId, callId);
              hasToolCalls = true;
              controller.enqueue(
                encodeChunk({
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: String(event.delta ?? '') },
                        id: callId,
                        index,
                      },
                    ],
                  },
                  index: 0,
                }),
              );
              emitted = true;
              continue;
            }
            if (event.type === 'response.completed') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (event.type === 'response.incomplete') {
              if (pendingStopText) {
                controller.enqueue(
                  encodeChunk({
                    delta: { content: pendingStopText },
                    index: 0,
                  }),
                );
                pendingStopText = '';
              }
              const incompleteReason =
                event.response && typeof event.response === 'object'
                  ? (
                      (event.response as { incomplete_details?: unknown })
                        .incomplete_details as { reason?: unknown } | undefined
                    )?.reason
                  : undefined;
              if (!emittedFinish) {
                controller.enqueue(
                  encodeChunk({
                    delta: {},
                    finish_reason:
                      incompleteReason === 'content_filter'
                        ? 'content_filter'
                        : 'length',
                    index: 0,
                  }),
                );
              }
              enqueueUsage(controller);
              emittedFinish = true;
              emitted = true;
              if (stoppedLocally) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                await cancelAndReleaseReader('Stop sequence matched');
                await recordStreamUsage();
                controller.close();
                return;
              }
              continue;
            }
            if (
              event.type === 'response.failed' ||
              event.type === 'response.error' ||
              event.type === 'error'
            ) {
              const failure =
                event.error ??
                (event.response && typeof event.response === 'object'
                  ? (event.response as { error?: unknown }).error
                  : undefined);
              const message =
                failure && typeof failure === 'object'
                  ? String(
                      (failure as { message?: unknown }).message ?? failure,
                    )
                  : String(failure ?? 'Upstream Responses stream failed');
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { message } })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              await cancelAndReleaseReader();
              await recordStreamUsage();
              controller.close();
              return;
            }
          } catch {
            // Ignore malformed upstream events and continue reading.
          }
        }
        if (stoppedLocally) continue;
        if (emitted) return;
      }
    },
    async cancel(reason) {
      await cancelAndReleaseReader(reason);
      await recordStreamUsage();
    },
  });

  return new Response(stream, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
    status: upstreamResponse.status,
  });
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
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
          if (frame.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            return;
          }
          controller.enqueue(encoder.encode(`${processFrame(frame)}\n\n`));
        });
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

            await recordProxyUsage({
              model,
              proxyContext,
              route,
              usage: latestUsage,
            });

            releaseReader();
            try {
              controller.close();
            } catch {
              // The downstream stream may have been cancelled while the pump was completing.
            }
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            controller.enqueue(
              encoder.encode(
                'data: {"error":{"message":"Upstream SSE frame exceeds the maximum size"}}\n\n',
              ),
            );
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
          flushFrames(frames);
        }
      };

      void pump();
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
      }
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

export const getModelsForCredential = async ({
  bearerToken,
  credentialData,
}: {
  bearerToken: string;
  credentialData: CredentialData;
}): Promise<DiscoveredModel[]> => {
  const configuredEndpoint = await getCodeBuddyApiEndpoint();
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${bearerToken}`,
  });
  const domain = getCredentialValue(credentialData, ['domain']);
  const apiEndpoint = String(domain ?? '')
    .toLowerCase()
    .endsWith('workbuddy.ai')
    ? 'https://www.workbuddy.ai'
    : configuredEndpoint;
  const enterpriseId = getCredentialValue(credentialData, [
    'enterprise_id',
    'enterpriseId',
  ]);
  const tenantId =
    getCredentialValue(credentialData, ['tenant_id', 'tenantId']) ??
    enterpriseId;
  const userId = getCredentialValue(credentialData, ['user_id', 'userId']);

  if (domain) {
    headers.set('X-Domain', String(domain));
  }

  if (enterpriseId) {
    headers.set('X-Enterprise-Id', String(enterpriseId));
  }

  if (tenantId) {
    headers.set('X-Tenant-Id', String(tenantId));
  }
  if (userId) {
    headers.set('X-User-Id', String(userId));
  }

  const fetchModels = async (path: string): Promise<Response> =>
    fetch(new URL(path, apiEndpoint), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  let response = await fetchModels('/v3/config');

  if ([400, 404, 405].includes(response.status)) {
    response = await fetchModels('/console/enterprises/personal/models');
  }

  if (!response.ok) {
    throw new Error(`Model discovery failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    code?: unknown;
    data?: {
      agents?: Array<{ models?: unknown; name?: unknown }>;
      models?: Array<{ disabled?: unknown; id?: unknown; name?: unknown }>;
    };
  };

  if (payload.code !== 0) {
    throw new Error('Model discovery returned an unsuccessful response');
  }

  const cliModels = payload.data?.agents?.find(
    (agent) => agent.name === 'cli',
  )?.models;
  const modelsById = new Map(
    (payload.data?.models ?? []).flatMap((model) => {
      const id = typeof model.id === 'string' ? model.id.trim() : '';

      if (!id || model.disabled === true) {
        return [];
      }

      return [
        [
          id,
          {
            displayName:
              typeof model.name === 'string' && model.name.trim()
                ? model.name
                : id,
            id,
          },
        ] as const,
      ];
    }),
  );
  const declaredModelIds = new Set(
    (payload.data?.models ?? [])
      .map((model) => (typeof model.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean),
  );

  if (!Array.isArray(cliModels)) {
    return [];
  }

  return cliModels.flatMap((modelId) => {
    if (typeof modelId !== 'string') {
      return [];
    }

    const model = modelsById.get(modelId);
    if (!model && declaredModelIds.has(modelId)) {
      return [];
    }
    return [
      model ?? {
        displayName: modelId,
        id: modelId,
      },
    ];
  });
};

export const getModelsForCredentials = async (
  credentials: CredentialRecord[],
): Promise<DiscoveredModel[]> => {
  const settled = await Promise.allSettled(
    credentials.map((credential) => {
      const supportedModels = getCredentialSupportedModels(credential.data);

      if (supportedModels.length) {
        return Promise.resolve(
          supportedModels.map((id) => ({ displayName: id, id })),
        );
      }

      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      return bearerToken
        ? getModelsForCredential({
            bearerToken,
            credentialData: credential.data,
          })
        : Promise.resolve([]);
    }),
  );
  const models = new Map<string, DiscoveredModel>();

  settled.forEach((result) => {
    if (result.status !== 'fulfilled') {
      return;
    }

    result.value.forEach((model) => {
      models.set(model.id, model);
    });
  });

  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
};

export const getModelsByCredential = async (
  credentials: CredentialRecord[],
): Promise<
  Record<string, { error: string | null; models: DiscoveredModel[] }>
> => {
  const results = await Promise.all(
    credentials.map(async (credential) => {
      const bearerToken = String(
        credential.data.bearer_token ?? credential.data.access_token ?? '',
      ).trim();

      try {
        const models = bearerToken
          ? await getModelsForCredential({
              bearerToken,
              credentialData: credential.data,
            })
          : [];

        return [credential.filename, { error: null, models }] as const;
      } catch (error) {
        return [
          credential.filename,
          {
            error:
              error instanceof Error ? error.message : 'Model discovery failed',
            models: [],
          },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(results);
};

export const getModelsResponse = async (
  request?: NextRequest,
): Promise<Response> => {
  const accessKey = request ? await resolveRequestAccessKey(request) : null;
  const models = (
    await getModelsForCredentials(
      await listEligibleCredentialRecords(accessKey?.credentialFilenames),
    )
  ).map((model) => ({
    id: model.id,
    slug: model.id,
    display_name: model.displayName,
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
    const resolvedContext =
      context ?? (await resolveProxyContext(request, body.model));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = await buildUpstreamBody(body, resolvedContext);

    if (resolvedContext.preferences.upstreamProtocol === 'responses') {
      const unsupportedOptions = getUnsupportedResponsesChatOptions(body);
      if (unsupportedOptions.length) {
        return createErrorResponse(
          400,
          `Unsupported Chat options for Responses upstream: ${unsupportedOptions.join(', ')}`,
        );
      }
      const apiEndpoint = await getCodeBuddyApiEndpoint();
      const upstreamUrl = `${apiEndpoint}/responses`;
      const upstreamHeaders = new Headers(
        await buildUpstreamHeaders(request, resolvedContext.auth),
      );
      const responsesBody = {
        ...buildResponsesBodyFromChat(upstreamBody),
        stream: Boolean(body.stream),
      };

      setDebugUpstreamRequest(debugTrace, {
        body: responsesBody,
        headers: headersToRecord(upstreamHeaders),
        method: 'POST',
        url: upstreamUrl,
      });

      let upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(responsesBody),
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
          route: usageRoute,
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
        return mapResponsesStreamToChat(
          upstreamResponse,
          String(upstreamBody.model ?? 'unknown'),
          resolvedContext,
          usageRoute,
          body.stop,
          Boolean(body.stream_options?.include_usage) ||
            usageRoute === '/v1/messages',
        );
      }

      const payload = (await upstreamResponse.json()) as Record<
        string,
        unknown
      >;
      await recordProxyUsage({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        usage: payload.usage ?? null,
      });
      if (payload.status === 'failed' || payload.error) {
        const error =
          payload.error && typeof payload.error === 'object'
            ? (payload.error as { message?: unknown })
            : undefined;
        return createErrorResponse(
          502,
          typeof error?.message === 'string'
            ? error.message
            : 'Upstream Responses request failed',
          payload.error,
        );
      }
      return Response.json(
        mapResponsesPayloadToChat(
          payload,
          String(upstreamBody.model ?? 'unknown'),
          body.stop,
        ),
      );
    }

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
  onResponseId?: (responseId: string) => Promise<void>,
): Promise<Response> => {
  try {
    const resolvedContext =
      context ??
      (await resolveProxyContext(
        request,
        typeof body.model === 'string' ? body.model : undefined,
      ));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = {
      ...normalizeResponsesUpstreamBody(body),
      model:
        typeof body.model === 'string' && body.model.trim()
          ? body.model
          : await getDefaultModel(),
    };
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/responses`;
    const upstreamHeaders = new Headers(
      await buildUpstreamHeaders(request, resolvedContext.auth),
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
      let responseId: string | null = null;

      try {
        const payload = JSON.parse(payloadText) as unknown;
        usage = extractResponsesUsage(payload) ?? fallbackUsage;
        responseId = extractResponsesId(payload);
      } catch {
        // Preserve malformed upstream JSON while retaining header usage.
      }

      if (responseId && onResponseId) {
        await onResponseId(responseId);
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
        onResponseId,
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
      url: `${await getCodeBuddyApiEndpoint()}/responses`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};
