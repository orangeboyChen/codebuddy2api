import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir } from './config';

export interface DebugLogEntry {
  createdAt: string;
  error: string | null;
  id: string;
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
}

export interface DebugHttpSnapshot {
  body: unknown;
  headers: Record<string, string>;
  status: number;
}

export interface DebugSettings {
  enabled: boolean;
  maxEntries: number;
}

export interface DebugTrace {
  createdAt: string;
  error: string | null;
  id: string;
  pending: Promise<void>[];
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: DebugHttpSnapshot | null;
  upstreamRequest: DebugUpstreamRequest | null;
  upstreamResponse: DebugHttpSnapshot | null;
}

interface DebugConfigFile {
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
  enabled: false,
  maxEntries: 100,
};

const MAX_SNAPSHOT_TEXT_LENGTH = 200_000;

const getDebugConfigPath = (): string => {
  return path.join(getConfigDir(), 'debug-config.json');
};

const getDebugLogsPath = (): string => {
  return path.join(getConfigDir(), 'debug-logs.json');
};

const ensureConfigDir = (): void => {
  fs.mkdirSync(getConfigDir(), { recursive: true });
};

const readJsonFile = <T>(filePath: string, fallback: T): T => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (!content) {
      return fallback;
    }

    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
};

const toHeadersRecord = (headers: Headers): Record<string, string> => {
  return Object.fromEntries(headers.entries());
};

const truncateString = (value: string): string => {
  if (value.length <= MAX_SNAPSHOT_TEXT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_SNAPSHOT_TEXT_LENGTH)}\n...[truncated]`;
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
      return JSON.parse(trimmed) as Record<string, unknown> | unknown[];
    } catch {
      return truncateString(trimmed);
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

export const getDebugSettings = (): DebugSettings => {
  const file = readJsonFile<DebugConfigFile>(getDebugConfigPath(), {});

  return {
    enabled:
      typeof file.enabled === 'boolean'
        ? file.enabled
        : DEFAULT_DEBUG_SETTINGS.enabled,
    maxEntries: normalizeMaxEntries(file.maxEntries),
  };
};

export const updateDebugSettings = (
  nextSettings: Partial<DebugSettings>,
): DebugSettings => {
  const current = getDebugSettings();
  const merged: DebugSettings = {
    enabled:
      typeof nextSettings.enabled === 'boolean'
        ? nextSettings.enabled
        : current.enabled,
    maxEntries:
      nextSettings.maxEntries !== undefined
        ? normalizeMaxEntries(nextSettings.maxEntries)
        : current.maxEntries,
  };

  ensureConfigDir();
  fs.writeFileSync(getDebugConfigPath(), JSON.stringify(merged, null, 2));

  return merged;
};

export const listDebugLogs = (): DebugLogEntry[] => {
  const logs = readJsonFile<DebugLogEntry[]>(getDebugLogsPath(), []);

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

export const clearDebugLogs = (): void => {
  ensureConfigDir();
  fs.writeFileSync(getDebugLogsPath(), JSON.stringify([], null, 2));
};

export const isDebugEnabled = (): boolean => {
  return getDebugSettings().enabled;
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
    createdAt: new Date().toISOString(),
    error: null,
    id: crypto.randomUUID(),
    pending: [],
    requestBody,
    requestKey,
    route,
    transformedResponse: null,
    upstreamRequest: null,
    upstreamResponse: null,
  };
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

  trace.upstreamRequest = request;
};

const captureResponseSnapshot = async (
  response: Response,
): Promise<DebugHttpSnapshot> => {
  const clone = response.clone();
  const text = await clone.text();
  const contentType = clone.headers.get('content-type') ?? '';

  return {
    body: tryParseBody(text, contentType),
    headers: toHeadersRecord(clone.headers),
    status: clone.status,
  };
};

export const enqueueUpstreamResponseSnapshot = (
  trace: DebugTrace | undefined,
  response: Response,
): void => {
  if (!trace) {
    return;
  }

  trace.pending.push(
    captureResponseSnapshot(response)
      .then((snapshot) => {
        trace.upstreamResponse = snapshot;
      })
      .catch((error) => {
        setDebugTraceError(trace, error);
      }),
  );
};

const appendDebugLog = (entry: DebugLogEntry): void => {
  const settings = getDebugSettings();
  const currentLogs = listDebugLogs();
  const nextLogs = [entry, ...currentLogs].slice(0, settings.maxEntries);

  ensureConfigDir();
  fs.writeFileSync(getDebugLogsPath(), JSON.stringify(nextLogs, null, 2));
};

export const finalizeDebugTrace = (
  trace: DebugTrace | undefined,
  response: Response,
): void => {
  if (!trace) {
    return;
  }

  trace.pending.push(
    captureResponseSnapshot(response)
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
      appendDebugLog({
        createdAt: trace.createdAt,
        error: trace.error,
        id: trace.id,
        requestBody: trace.requestBody,
        requestKey: trace.requestKey,
        route: trace.route,
        transformedResponse: trace.transformedResponse,
        upstreamRequest: trace.upstreamRequest,
        upstreamResponse: trace.upstreamResponse,
      });
    });
};
