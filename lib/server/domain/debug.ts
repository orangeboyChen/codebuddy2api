import crypto from 'node:crypto';

import {
  appendStorageDebugLogs,
  clearStorageDebugLogs,
  getStorageBackendMeta,
  listStorageDebugLogs,
  readStorageJson,
  trimStorageDebugLogs,
  writeStorageJson,
} from '../storage';

export interface DebugLogEntry {
  credentialFilename: string | null;
  createdAt: string;
  elapsedMs: number;
  error: string | null;
  id: string;
  model: string | null;
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
  usage: DebugUsageMetrics | null;
}

export interface DebugUsageMetrics {
  cacheCreationTokens: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DebugHttpSnapshot {
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

export interface DebugSettings {
  autoRefreshSeconds: number;
  enabled: boolean;
  maxEntries: number;
}

export interface DebugTrace {
  credentialFilename: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  pending: Promise<void>[];
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  startedAtMs: number;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
}

interface DebugConfigFile {
  autoRefreshSeconds?: number;
  enabled?: boolean;
  maxEntries?: number;
}

export interface DebugUpstreamRequest {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

const DEFAULT_DEBUG_SETTINGS: DebugSettings = {
  autoRefreshSeconds: 0,
  enabled: false,
  maxEntries: 10,
};

const MAX_SNAPSHOT_TEXT_LENGTH = 200_000;
const FLUSH_INTERVAL_MS = 1000;
const DEBUG_SETTINGS_CACHE_TTL_MS = 1000;
const MAX_PENDING_LOGS = 100;
const REDACTED_VALUE = '[redacted]';
let debugWriteQueue: Promise<void> = Promise.resolve();
let pendingDebugLogs: DebugLogEntry[] = [];
let pendingDebugFlushes = 0;
let pendingDebugTraces = 0;
let debugFlushTimer: ReturnType<typeof setTimeout> | null = null;
let debugSettingsCache: {
  cachedAt: number;
  key: string;
  value: DebugSettings;
} | null = null;
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-user-id',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_FIELD_NAMES = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bearer_token',
  'cookie',
  'id_token',
  'refresh_token',
  'requestkey',
  'request_key',
  'secret',
  'session_state',
  'set-cookie',
  'token',
  'user_id',
  'x-api-key',
  'x-user-id',
  'x_user_id',
]);
const JSON_STRING_PROPERTY_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*(?:"|$))/g;

const enqueueDebugWrite = async <T>(mutation: () => Promise<T>): Promise<T> => {
  const operation = debugWriteQueue.then(mutation, mutation);
  debugWriteQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

const maskSensitiveString = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed) {
    return value;
  }

  const bearerPrefixMatch = trimmed.match(/^Bearer\s+/i);

  if (bearerPrefixMatch) {
    const token = trimmed.slice(bearerPrefixMatch[0].length);

    if (!token) {
      return '';
    }

    if (token.length <= 4) {
      return '****';
    }

    if (token.length <= 12) {
      return `${token.slice(0, 4)}${'*'.repeat(Math.max(4, token.length - 4))}`;
    }

    return `${token.slice(0, 8)}${'*'.repeat(token.length - 12)}${token.slice(-4)}`;
  }

  if (trimmed.length <= 4) {
    return '****';
  }

  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 4)}${'*'.repeat(Math.max(4, trimmed.length - 4))}`;
  }

  return `${trimmed.slice(0, 8)}${'*'.repeat(trimmed.length - 12)}${trimmed.slice(-4)}`;
};

const isSensitiveFieldName = (name: string): boolean => {
  return SENSITIVE_FIELD_NAMES.has(name.trim().toLowerCase());
};

const sanitizeValue = (value: unknown, key?: string): unknown => {
  if (typeof key === 'string' && isSensitiveFieldName(key)) {
    if (value === null || value === undefined || value === '') {
      return value;
    }

    return typeof value === 'string'
      ? maskSensitiveString(value)
      : REDACTED_VALUE;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          sanitizeValue(entryValue, entryKey),
        ],
      ),
    );
  }

  return value;
};

const sanitizeHeadersRecord = (
  headers: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.trim().toLowerCase())
        ? maskSensitiveString(value)
        : truncateString(value),
    ]),
  );
};

const toHeadersRecord = (headers: Headers): Record<string, string> => {
  return sanitizeHeadersRecord(Object.fromEntries(headers.entries()));
};

const truncateString = (value: string): string => {
  if (value.length <= MAX_SNAPSHOT_TEXT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_SNAPSHOT_TEXT_LENGTH)}\n...[truncated]`;
};

const redactSensitiveJsonFields = (value: string): string => {
  return value.replace(
    JSON_STRING_PROPERTY_PATTERN,
    (match, serializedKey: string, separator: string) => {
      try {
        const key = JSON.parse(serializedKey) as unknown;

        return typeof key === 'string' && isSensitiveFieldName(key)
          ? `${serializedKey}${separator}${JSON.stringify(REDACTED_VALUE)}`
          : match;
      } catch {
        return match;
      }
    },
  );
};

const tryParseBody = (
  text: string,
  contentType: string,
): string | Record<string, unknown> | unknown[] => {
  const trimmed = text.trim();

  if (!trimmed) {
    return '';
  }

  if (contentType.toLowerCase().includes('application/json')) {
    try {
      return sanitizeValue(
        JSON.parse(trimmed) as Record<string, unknown> | unknown[],
      ) as Record<string, unknown> | unknown[];
    } catch {
      return redactSensitiveJsonFields(trimmed);
    }
  }

  return truncateString(text);
};

const normalizeMaxEntries = (value: unknown): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_DEBUG_SETTINGS.maxEntries;
  }

  return Math.min(1000, Math.max(1, numeric));
};

const normalizeAutoRefreshSeconds = (value: unknown): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(numeric) || numeric < 0) {
    return DEFAULT_DEBUG_SETTINGS.autoRefreshSeconds;
  }

  const allowedValues = new Set([0, 5, 10, 15, 30, 60, 120, 300]);

  return allowedValues.has(numeric)
    ? numeric
    : DEFAULT_DEBUG_SETTINGS.autoRefreshSeconds;
};

const getDebugSettingsCacheKey = (): string => {
  return [
    process.cwd(),
    process.env.CODEBUDDY_CONFIG_PATH ?? '',
    process.env.CODEBUDDY_STORAGE_BACKEND ?? '',
    process.env.CODEBUDDY_STORAGE_FILE_DIR ?? '',
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH ?? '',
  ].join(':');
};

const readDebugSettings = async (): Promise<DebugSettings> => {
  const file =
    (await readStorageJson<DebugConfigFile>('debug', 'settings')) ?? {};

  const settings = {
    autoRefreshSeconds: normalizeAutoRefreshSeconds(file.autoRefreshSeconds),
    enabled:
      typeof file.enabled === 'boolean'
        ? file.enabled
        : DEFAULT_DEBUG_SETTINGS.enabled,
    maxEntries: normalizeMaxEntries(file.maxEntries),
  };
  debugSettingsCache = {
    cachedAt: Date.now(),
    key: getDebugSettingsCacheKey(),
    value: settings,
  };
  return settings;
};

export const getDebugSettings = async (): Promise<DebugSettings> => {
  return readDebugSettings();
};

export const updateDebugSettings = async (
  nextSettings: Partial<DebugSettings>,
): Promise<DebugSettings> => {
  const current = await readDebugSettings();
  const merged: DebugSettings = {
    autoRefreshSeconds:
      nextSettings.autoRefreshSeconds !== undefined
        ? normalizeAutoRefreshSeconds(nextSettings.autoRefreshSeconds)
        : current.autoRefreshSeconds,
    enabled:
      typeof nextSettings.enabled === 'boolean'
        ? nextSettings.enabled
        : current.enabled,
    maxEntries:
      nextSettings.maxEntries !== undefined
        ? normalizeMaxEntries(nextSettings.maxEntries)
        : current.maxEntries,
  };

  await enqueueDebugWrite(async () => {
    await writeStorageJson('debug', 'settings', merged);

    if (getStorageBackendMeta().backend !== 'file') {
      await trimStorageDebugLogs(merged.maxEntries);
      return;
    }

    const logs = await readDebugLogs();
    await writeStorageJson('debug', 'logs', logs.slice(0, merged.maxEntries));
  });
  debugSettingsCache = {
    cachedAt: Date.now(),
    key: getDebugSettingsCacheKey(),
    value: merged,
  };

  return merged;
};

const readDebugLogs = async (): Promise<DebugLogEntry[]> => {
  if (getStorageBackendMeta().backend !== 'file') {
    const settings = await getDebugSettings();
    const events = await listStorageDebugLogs(settings.maxEntries);
    return events
      .filter((event): event is typeof event & { payload: DebugLogEntry } => {
        const entry = event.payload;
        return Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as DebugLogEntry).id === 'string',
        );
      })
      .map((event) => event.payload);
  }

  const logs = (await readStorageJson<DebugLogEntry[]>('debug', 'logs')) ?? [];

  if (!Array.isArray(logs)) {
    return [];
  }

  return logs.filter((log): log is DebugLogEntry => {
    return Boolean(
      log &&
      typeof log === 'object' &&
      typeof log.id === 'string' &&
      typeof log.route === 'string' &&
      typeof log.createdAt === 'string',
    );
  });
};

export const listDebugLogs = async (): Promise<DebugLogEntry[]> => {
  return readDebugLogs();
};

export const hasPendingDebugLogWrites = (): boolean => {
  return Boolean(
    pendingDebugLogs.length ||
    debugFlushTimer ||
    pendingDebugFlushes ||
    pendingDebugTraces,
  );
};

export const clearDebugLogs = async (): Promise<void> => {
  pendingDebugLogs = [];
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
  }
  await enqueueDebugWrite(async () => {
    if (getStorageBackendMeta().backend !== 'file') {
      await clearStorageDebugLogs();
      return;
    }
    await writeStorageJson('debug', 'logs', []);
  });
};

export const isDebugEnabled = async (): Promise<boolean> => {
  const cacheKey = getDebugSettingsCacheKey();

  if (
    debugSettingsCache?.key === cacheKey &&
    Date.now() - debugSettingsCache.cachedAt < DEBUG_SETTINGS_CACHE_TTL_MS
  ) {
    return debugSettingsCache.value.enabled;
  }

  return (await readDebugSettings()).enabled;
};

export const createDebugTrace = ({
  requestBody,
  requestKey,
  route,
}: {
  requestBody: unknown;
  requestKey: string | null;
  route: string;
}): DebugTrace => {
  return {
    credentialFilename: null,
    createdAt: new Date().toISOString(),
    error: null,
    id: crypto.randomUUID(),
    pending: [],
    requestBody: sanitizeValue(requestBody),
    requestKey:
      typeof requestKey === 'string'
        ? maskSensitiveString(requestKey)
        : requestKey,
    route,
    startedAtMs: Date.now(),
    transformedResponse: null,
    upstreamRequest: null,
    upstreamResponse: null,
  };
};

export const setDebugTraceCredential = (
  trace: DebugTrace | undefined,
  credentialFilename: string | null,
): void => {
  if (!trace) {
    return;
  }

  trace.credentialFilename = credentialFilename;
};

export const setDebugTraceError = (
  trace: DebugTrace | undefined,
  error: unknown,
): void => {
  if (!trace) {
    return;
  }

  trace.error =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
};

export const setDebugUpstreamRequest = (
  trace: DebugTrace | undefined,
  request: DebugUpstreamRequest,
): void => {
  if (!trace) {
    return;
  }

  trace.upstreamRequest = {
    ...request,
    body: sanitizeValue(request.body),
    headers: sanitizeHeadersRecord(request.headers),
  };
};

const captureResponseSnapshot = (
  response: Response,
): { response: Response; snapshot: Promise<DebugHttpSnapshot> } => {
  const contentType = response.headers.get('content-type') ?? '';
  const decoder = new TextDecoder();
  let text = '';
  let capturedLength = 0;
  let truncated = false;
  let resolveSnapshot: (snapshot: DebugHttpSnapshot) => void;
  const snapshot = new Promise<DebugHttpSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  let completed = false;
  const finish = (): void => {
    if (completed) return;
    completed = true;
    text += decoder.decode();
    resolveSnapshot({
      body: tryParseBody(
        truncated ? `${text}\n...[truncated]` : text,
        contentType,
      ),
      headers: toHeadersRecord(response.headers),
      status: response.status,
    });
  };
  const capture = (chunk: Uint8Array): void => {
    if (truncated) return;

    const remaining = MAX_SNAPSHOT_TEXT_LENGTH - capturedLength;
    const decoded = decoder.decode(chunk, { stream: true });

    if (decoded.length <= remaining) {
      text += decoded;
      capturedLength += decoded.length;
      return;
    }

    text += decoded.slice(0, remaining);
    capturedLength += remaining;
    truncated = true;
  };

  if (!response.body) {
    finish();
    return { response, snapshot };
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason): Promise<void> {
      await reader.cancel(reason);
      finish();
    },
    async pull(controller): Promise<void> {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          finish();
          controller.close();
          reader.releaseLock();
          return;
        }

        capture(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
        reader.releaseLock();
      }
    },
  });

  return {
    response: new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
    snapshot,
  };
};

const readSnapshotText = async (response: Response): Promise<string> => {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let capturedLength = 0;
  let truncated = false;

  try {
    while (capturedLength < MAX_SNAPSHOT_TEXT_LENGTH) {
      const chunk = await reader.read();

      if (chunk.done) {
        text += decoder.decode();
        break;
      }

      const remaining = MAX_SNAPSHOT_TEXT_LENGTH - capturedLength;
      const decoded = decoder.decode(chunk.value, { stream: true });

      if (decoded.length <= remaining) {
        text += decoded;
        capturedLength += decoded.length;
        continue;
      }

      text += decoded.slice(0, remaining);
      truncated = true;
      break;
    }
  } finally {
    if (truncated) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  return truncated ? `${text}\n...[truncated]` : text;
};

const captureIndependentResponseSnapshot = async (
  response: Response,
): Promise<DebugHttpSnapshot> => {
  const clone = response.clone();

  return {
    body: tryParseBody(
      await readSnapshotText(clone),
      clone.headers.get('content-type') ?? '',
    ),
    headers: toHeadersRecord(clone.headers),
    status: clone.status,
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const toTokenCount = (value: unknown): number => {
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
};

const getTraceModel = (trace: DebugTrace): string | null => {
  const upstreamBody = asRecord(trace.upstreamRequest?.body);
  const requestBody = asRecord(trace.requestBody);
  const model = upstreamBody?.model ?? requestBody?.model;

  return typeof model === 'string' && model.trim() ? model.trim() : null;
};

const getResponseRecord = (body: unknown): Record<string, unknown> | null => {
  const record = asRecord(body);

  if (record) {
    return record;
  }

  if (typeof body !== 'string') {
    return null;
  }

  const events = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    )
    .filter(Boolean);

  for (const event of events.reverse()) {
    try {
      const parsed = asRecord(JSON.parse(event) as unknown);
      if (getResponseUsage(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON SSE sentinels such as [DONE].
    }
  }

  try {
    return asRecord(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
};

const getResponseUsage = (
  response: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  return (
    asRecord(asRecord(response?.response)?.usage) ?? asRecord(response?.usage)
  );
};

const getTraceUsage = (trace: DebugTrace): DebugUsageMetrics | null => {
  const responseBody =
    getResponseRecord(trace.transformedResponse?.body) ??
    getResponseRecord(trace.upstreamResponse?.body);
  const usage = getResponseUsage(responseBody);

  if (!usage) {
    return null;
  }

  const inputTokens = toTokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = toTokenCount(
    usage.output_tokens ?? usage.completion_tokens,
  );
  const promptTokenDetails = asRecord(usage.prompt_tokens_details);
  const cacheReadTokens = toTokenCount(
    usage.cache_read_input_tokens ?? promptTokenDetails?.cached_tokens,
  );
  const cacheCreationTokens = toTokenCount(
    usage.cache_creation_input_tokens ??
      promptTokenDetails?.cache_creation_tokens,
  );
  const totalTokens =
    toTokenCount(usage.total_tokens) ||
    inputTokens +
      outputTokens +
      (promptTokenDetails ? 0 : cacheReadTokens + cacheCreationTokens);

  return {
    cacheCreationTokens,
    cacheReadTokens,
    inputTokens,
    outputTokens,
    totalTokens,
  };
};

export const enqueueUpstreamResponseSnapshot = (
  trace: DebugTrace | undefined,
  response: Response,
): Response => {
  if (!trace) {
    return response;
  }

  const captured = captureResponseSnapshot(response);

  trace.pending.push(
    captured.snapshot
      .then((snapshot) => {
        trace.upstreamResponse = snapshot;
      })
      .catch((error) => {
        setDebugTraceError(trace, error);
      }),
  );
  return captured.response;
};

const appendDebugLog = async (entry: DebugLogEntry): Promise<void> => {
  pendingDebugLogs.push(entry);

  if (pendingDebugLogs.length >= MAX_PENDING_LOGS) {
    void flushPendingDebugLogs().catch(() => undefined);
    return;
  }

  scheduleDebugFlush();
};

const flushPendingDebugLogs = async (): Promise<void> => {
  if (debugFlushTimer) {
    clearTimeout(debugFlushTimer);
    debugFlushTimer = null;
  }

  const entries = pendingDebugLogs.splice(0, MAX_PENDING_LOGS);

  if (!entries.length) {
    await debugWriteQueue;
    return;
  }

  pendingDebugFlushes += 1;

  try {
    await enqueueDebugWrite(async () => {
      if (getStorageBackendMeta().backend !== 'file') {
        const settings = await getDebugSettings();
        await appendStorageDebugLogs(
          entries.map((entry) => ({
            id: entry.id,
            payload: entry,
            timestamp: entry.createdAt,
          })),
        );
        await trimStorageDebugLogs(settings.maxEntries);
        if (pendingDebugLogs.length) {
          scheduleDebugFlush();
        }
        return;
      }
      const settings = await getDebugSettings();
      const currentLogs = await readDebugLogs();
      const nextLogs = [...entries]
        .reverse()
        .concat(currentLogs)
        .slice(0, settings.maxEntries);
      await writeStorageJson('debug', 'logs', nextLogs);
      if (pendingDebugLogs.length) {
        scheduleDebugFlush();
      }
    });
  } catch (error) {
    pendingDebugLogs = [...entries, ...pendingDebugLogs];
    scheduleDebugFlush();
    throw error;
  } finally {
    pendingDebugFlushes -= 1;
  }
};

const scheduleDebugFlush = (): void => {
  if (debugFlushTimer) return;
  debugFlushTimer = setTimeout(() => {
    void flushPendingDebugLogs().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  debugFlushTimer.unref?.();
};

export const finalizeDebugTrace = (
  trace: DebugTrace | undefined,
  response: Response,
): Response => {
  if (!trace) {
    return response;
  }

  pendingDebugTraces += 1;

  trace.pending.push(
    captureIndependentResponseSnapshot(response)
      .then((snapshot) => {
        trace.transformedResponse = snapshot;
      })
      .catch((error) => {
        setDebugTraceError(trace, error);
      }),
  );

  void Promise.all(trace.pending)
    .catch((error) => {
      setDebugTraceError(trace, error);
    })
    .finally(() => {
      const elapsedMs = Math.max(0, Date.now() - trace.startedAtMs);
      void appendDebugLog({
        credentialFilename: trace.credentialFilename,
        createdAt: trace.createdAt,
        elapsedMs,
        error: trace.error,
        id: trace.id,
        model: getTraceModel(trace),
        requestBody: trace.requestBody,
        requestKey: trace.requestKey,
        route: trace.route,
        transformedResponse: trace.transformedResponse,
        upstreamRequest: trace.upstreamRequest,
        upstreamResponse: trace.upstreamResponse,
        usage: getTraceUsage(trace),
      });
      pendingDebugTraces -= 1;
    });
  return response;
};
