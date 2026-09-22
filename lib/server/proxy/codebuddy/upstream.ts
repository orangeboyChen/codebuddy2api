import type { NextRequest } from 'next/server';

import { getCodeBuddyApiEndpoint, getDefaultModel } from '../../domain/config';
import { getCredentialSupportedModels } from '../../domain/credentials';
import { resolveHyChatThinking } from '../../shared/hy-thought-depth';
import { resolveModelChatThinking } from '../../shared/thinking-effort';
import { getRequestHeaderMap } from '../../shared/http';
import { getCredentialValue } from './context';
import {
  type CacheableTextBlock,
  type ChatRequestBody,
  CODEBUDDY_CLI_VERSION,
  CODEBUDDY_USER_AGENT,
  MIN_AUTO_CACHE_TEXT_LENGTH,
  type OpenAIMessage,
  type ProxyContext,
  type ResolvedAuth,
} from './types';

export const hasPromptCacheControl = (content: unknown): boolean => {
  return (
    Array.isArray(content) &&
    content.some(
      (part) => !!part && typeof part === 'object' && 'cache_control' in part,
    )
  );
};

export const createCacheableTextBlock = (text: string): CacheableTextBlock => ({
  type: 'text',
  text,
  cache_control: { type: 'ephemeral' },
});

export const addPromptCacheControl = (
  message: OpenAIMessage,
): OpenAIMessage => {
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

export const applyPromptCacheControl = (
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

export const normalizeMessages = (
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

export const buildUpstreamHeaders = async (
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

export const headersToRecord = (
  headers: HeadersInit,
): Record<string, string> => {
  return Object.fromEntries(new Headers(headers).entries());
};

export const buildUpstreamBody = async (
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

  // The Hy conversion runs first: it speaks a vocabulary no client does, so
  // what it produces — not what arrived — is what the model's advertised
  // efforts have to be checked against.
  const hyThinking = await resolveHyChatThinking(model, body);
  const thinking = resolveModelChatThinking(
    context.auth.credentialData,
    model,
    {
      reasoning_effort: hyThinking.reasoningEffort,
      thinking: hyThinking.thinking,
    },
  );

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
    thinking: thinking.thinking,
    reasoning_effort: thinking.reasoningEffort,
  };
};
