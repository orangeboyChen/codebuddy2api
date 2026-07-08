import type { NextRequest } from 'next/server';

import {
  getActiveConfig,
  getAvailableModels,
  getCodeBuddyApiEndpoint,
} from './config';
import { resolveCredentialForRequest } from './credentials';
import { createErrorResponse, getRequestHeaderMap } from './http';
import { recordModelUsage } from './stats';

type OpenAIMessage = {
  role?: string;
  content?: unknown;
};

type ChatRequestBody = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
};

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

  return filtered.map((item) => {
    if (item.role === 'tool') {
      return { ...item, role: 'user' };
    }

    return item;
  });
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

  return {
    model: body.model ?? getAvailableModels()[0] ?? 'glm-5.1',
    messages: normalizedMessages,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    stop: body.stop,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
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
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      });
    }

    return new Response(await upstreamResponse.text(), {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch (error) {
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};
