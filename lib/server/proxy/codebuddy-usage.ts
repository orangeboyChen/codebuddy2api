import { recordUsageEvent, type UsageSnapshot } from '../domain/usage';
import type { ProxyContext } from './codebuddy-types';

export const toUsageSnapshot = (usage: unknown): UsageSnapshot | null => {
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  return usage as UsageSnapshot;
};

export const recordProxyUsage = async ({
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

export const extractResponsesUsage = (value: unknown): unknown => {
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

export const mapResponsesUsageToChat = (
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

export const extractResponsesId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const payload = value as {
    id?: unknown;
    response?: { id?: unknown };
  };
  const id = payload.response?.id ?? payload.id;
  return typeof id === 'string' && id ? id : null;
};

export const parseUsageHeader = (response: Response): unknown => {
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

export const logUpstreamFailure = ({
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
