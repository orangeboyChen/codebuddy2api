import fs from 'node:fs';
import path from 'node:path';

import { listAccessKeys } from './access-keys';
import { getConfigDir } from './config';
import { listCredentialFilenames } from './credentials';

export type UsageRange =
  '1h' | '3h' | '6h' | '12h' | '24h' | '3d' | '7d' | 'today' | 'yesterday';

export interface UsageSnapshot {
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  completion_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  prompt_tokens?: number | null;
  total_tokens?: number | null;
}

export interface UsageEventRecord {
  accessKeyId: string | null;
  accessKeyName: string | null;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  callCount: number;
  credentialFilename: string | null;
  inputTokens: number;
  model: string;
  outputTokens: number;
  route: string;
  timestamp: string;
  totalTokens: number;
}

interface UsageStore {
  events: UsageEventRecord[];
}

interface UsageBucketTotals {
  callCount: number;
  cacheHitTokens: number;
  totalTokens: number;
}

interface UsageBucket {
  label: string;
  start: string;
}

export interface UsageChartSeries {
  model: string;
  points: Array<UsageBucketTotals & UsageBucket>;
}

export interface UsageTableRow extends UsageBucketTotals {
  model: string;
}

export type UsageSummary = UsageBucketTotals;

export interface UsageFilterOption {
  label: string;
  value: string;
}

export interface UsageFilterOptions {
  accessKeys: UsageFilterOption[];
  credentials: UsageFilterOption[];
}

export interface UsageAnalyticsResponse {
  callSeries: UsageChartSeries[];
  filters: UsageFilterOptions;
  range: UsageRange;
  tableRows: UsageTableRow[];
  tokenSeries: UsageChartSeries[];
  todaySummary: UsageSummary;
}

const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const getUsageDir = (): string => {
  return path.join(getConfigDir(), 'usage');
};

const getUsagePath = (): string => {
  return path.join(getUsageDir(), 'history.json');
};

const ensureConfigDir = (): void => {
  fs.mkdirSync(getUsageDir(), { recursive: true });
};

const toNumber = (value: unknown): number => {
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return numeric;
};

const normalizeUsage = (usage: UsageSnapshot): UsageEventRecord => {
  const inputTokens = toNumber(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = toNumber(usage.output_tokens ?? usage.completion_tokens);
  const cacheReadTokens = toNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNumber(usage.cache_creation_input_tokens);
  const explicitTotal = toNumber(usage.total_tokens);
  const totalTokens =
    explicitTotal ||
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    accessKeyId: null,
    accessKeyName: null,
    cacheCreationTokens,
    cacheReadTokens,
    callCount: 1,
    credentialFilename: null,
    inputTokens,
    model: 'unknown',
    outputTokens,
    route: '',
    timestamp: new Date().toISOString(),
    totalTokens,
  };
};

const isUsageEventRecord = (value: unknown): value is UsageEventRecord => {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as UsageEventRecord).timestamp === 'string' &&
    typeof (value as UsageEventRecord).model === 'string' &&
    typeof (value as UsageEventRecord).route === 'string',
  );
};

const trimExpiredEvents = (events: UsageEventRecord[], nowMs: number) => {
  return events.filter((event) => {
    const timestampMs = Date.parse(event.timestamp);

    if (!Number.isFinite(timestampMs)) {
      return false;
    }

    return nowMs - timestampMs <= MAX_RETENTION_MS;
  });
};

const readUsageStore = (): UsageStore => {
  const filePath = getUsagePath();

  if (!fs.existsSync(filePath)) {
    return {
      events: [],
    };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (!content) {
      return {
        events: [],
      };
    }

    const parsed = JSON.parse(content) as Partial<UsageStore>;
    const events = Array.isArray(parsed.events)
      ? parsed.events.filter(isUsageEventRecord)
      : [];

    return {
      events,
    };
  } catch {
    return {
      events: [],
    };
  }
};

const writeUsageStore = (store: UsageStore): void => {
  ensureConfigDir();
  fs.writeFileSync(getUsagePath(), JSON.stringify(store, null, 2));
};

const persistTrimmedStore = (nowMs: number): UsageStore => {
  const store = readUsageStore();
  const trimmedEvents = trimExpiredEvents(store.events, nowMs);

  if (trimmedEvents.length !== store.events.length) {
    writeUsageStore({
      events: trimmedEvents,
    });
  }

  return {
    events: trimmedEvents,
  };
};

const getRangeWindow = (
  range: UsageRange,
  now: Date,
): {
  bucketCount: number;
  bucketSizeMs: number;
  endMs: number;
  startMs: number;
} => {
  const nowMs = now.getTime();

  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);

    return {
      bucketCount: Math.max(1, now.getHours() + 1),
      bucketSizeMs: HOUR_MS,
      endMs: nowMs,
      startMs: start.getTime(),
    };
  }

  if (range === 'yesterday') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return {
      bucketCount: 24,
      bucketSizeMs: HOUR_MS,
      endMs: end.getTime(),
      startMs: start.getTime(),
    };
  }

  const bucketSizeMs = range === '3d' || range === '7d' ? DAY_MS : HOUR_MS;
  const bucketCount = {
    '1h': 1,
    '3h': 3,
    '6h': 6,
    '12h': 12,
    '24h': 24,
    '3d': 3,
    '7d': 7,
  }[range];

  return {
    bucketCount,
    bucketSizeMs,
    endMs: nowMs,
    startMs: nowMs - bucketCount * bucketSizeMs,
  };
};

const formatBucketLabel = (date: Date, bucketSizeMs: number): string => {
  return bucketSizeMs === DAY_MS
    ? date.toLocaleDateString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
      })
    : date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
};

const buildBuckets = (range: UsageRange, now: Date): UsageBucket[] => {
  const { bucketCount, bucketSizeMs, startMs } = getRangeWindow(range, now);

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketDate = new Date(startMs + bucketSizeMs * index);

    return {
      label: formatBucketLabel(bucketDate, bucketSizeMs),
      start: bucketDate.toISOString(),
    };
  });
};

const getBucketIndex = (
  range: UsageRange,
  eventTimeMs: number,
  now: Date,
): number => {
  const { bucketCount, bucketSizeMs, startMs } = getRangeWindow(range, now);
  const offset = eventTimeMs - startMs;

  if (offset < 0) {
    return -1;
  }

  const index = Math.floor(offset / bucketSizeMs);

  if (index < 0 || index >= bucketCount) {
    return -1;
  }

  return index;
};

const getTodayBounds = (now: Date) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    endMs: end.getTime(),
    startMs: start.getTime(),
  };
};

const matchesFilter = (
  event: UsageEventRecord,
  accessKey: string,
  credential: string,
) => {
  if (accessKey !== 'all' && event.accessKeyId !== accessKey) {
    return false;
  }

  if (credential !== 'all' && event.credentialFilename !== credential) {
    return false;
  }

  return true;
};

const createEmptyTotals = (): UsageBucketTotals => ({
  callCount: 0,
  cacheHitTokens: 0,
  totalTokens: 0,
});

const addEventToTotals = (
  totals: UsageBucketTotals,
  event: UsageEventRecord,
): UsageBucketTotals => ({
  callCount: totals.callCount + event.callCount,
  cacheHitTokens:
    totals.cacheHitTokens + event.cacheReadTokens + event.cacheCreationTokens,
  totalTokens: totals.totalTokens + event.totalTokens,
});

export const recordUsageEvent = ({
  accessKeyId,
  accessKeyName,
  credentialFilename,
  model,
  route,
  timestamp,
  usage,
}: {
  accessKeyId?: string | null;
  accessKeyName?: string | null;
  credentialFilename?: string | null;
  model: string;
  route: string;
  timestamp?: string;
  usage: UsageSnapshot | null | undefined;
}): void => {
  if (!usage) {
    return;
  }

  const base = normalizeUsage(usage);
  const event: UsageEventRecord = {
    ...base,
    accessKeyId: accessKeyId ?? null,
    accessKeyName: accessKeyName ?? null,
    credentialFilename: credentialFilename ?? null,
    model: model.trim() || 'unknown',
    route,
    timestamp: timestamp ?? new Date().toISOString(),
  };

  const nowMs = Date.now();
  const store = persistTrimmedStore(nowMs);
  store.events.push(event);
  writeUsageStore({
    events: store.events,
  });
};

export const clearUsageHistory = (): void => {
  writeUsageStore({
    events: [],
  });
};

export const getUsageAnalytics = ({
  accessKey = 'all',
  credential = 'all',
  now = new Date(),
  range,
}: {
  accessKey?: string;
  credential?: string;
  now?: Date;
  range: UsageRange;
}): UsageAnalyticsResponse => {
  const nowMs = now.getTime();
  const store = persistTrimmedStore(nowMs);
  const buckets = buildBuckets(range, now);
  const tokenSeriesByModel = new Map<string, UsageBucketTotals[]>();
  const callSeriesByModel = new Map<string, UsageBucketTotals[]>();
  const tableRowsByModel = new Map<string, UsageBucketTotals>();
  const todaySummary = createEmptyTotals();
  const todayBounds = getTodayBounds(now);
  const { endMs, startMs } = getRangeWindow(range, now);

  store.events.forEach((event) => {
    const eventMs = Date.parse(event.timestamp);

    if (!Number.isFinite(eventMs)) {
      return;
    }

    if (!matchesFilter(event, accessKey, credential)) {
      return;
    }

    if (eventMs >= todayBounds.startMs && eventMs < todayBounds.endMs) {
      const nextTodaySummary = addEventToTotals(todaySummary, event);
      todaySummary.callCount = nextTodaySummary.callCount;
      todaySummary.cacheHitTokens = nextTodaySummary.cacheHitTokens;
      todaySummary.totalTokens = nextTodaySummary.totalTokens;
    }

    if (eventMs < startMs || eventMs >= endMs) {
      return;
    }

    const bucketIndex = getBucketIndex(range, eventMs, now);

    if (bucketIndex < 0) {
      return;
    }

    const tokenBuckets =
      tokenSeriesByModel.get(event.model) ??
      Array.from({ length: buckets.length }, () => createEmptyTotals());
    const callBuckets =
      callSeriesByModel.get(event.model) ??
      Array.from({ length: buckets.length }, () => createEmptyTotals());
    const tableTotals =
      tableRowsByModel.get(event.model) ?? createEmptyTotals();

    tokenBuckets[bucketIndex] = addEventToTotals(
      tokenBuckets[bucketIndex],
      event,
    );
    callBuckets[bucketIndex] = {
      ...addEventToTotals(callBuckets[bucketIndex], event),
      totalTokens: callBuckets[bucketIndex].totalTokens,
      cacheHitTokens: callBuckets[bucketIndex].cacheHitTokens,
    };
    tableRowsByModel.set(event.model, addEventToTotals(tableTotals, event));
    tokenSeriesByModel.set(event.model, tokenBuckets);
    callSeriesByModel.set(event.model, callBuckets);
  });

  const toSeries = (
    modelMap: Map<string, UsageBucketTotals[]>,
    metric: 'tokens' | 'calls',
  ): UsageChartSeries[] => {
    return [...modelMap.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([model, points]) => ({
        model,
        points: points.map((point, index) => ({
          callCount: metric === 'calls' ? point.callCount : point.callCount,
          cacheHitTokens: point.cacheHitTokens,
          label: buckets[index].label,
          start: buckets[index].start,
          totalTokens:
            metric === 'tokens' ? point.totalTokens : point.totalTokens,
        })),
      }));
  };

  return {
    callSeries: toSeries(callSeriesByModel, 'calls'),
    filters: {
      accessKeys: [
        {
          label: '全部 API Key',
          value: 'all',
        },
        ...listAccessKeys().access_keys.map((item) => ({
          label: item.name,
          value: item.id,
        })),
      ],
      credentials: [
        {
          label: '全部凭据',
          value: 'all',
        },
        ...listCredentialFilenames().map((filename) => ({
          label: filename,
          value: filename,
        })),
      ],
    },
    range,
    tableRows: [...tableRowsByModel.entries()]
      .map(([model, totals]) => ({
        ...totals,
        model,
      }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    todaySummary,
    tokenSeries: toSeries(tokenSeriesByModel, 'tokens'),
  };
};

export const resetUsageHistory = (): void => {
  clearUsageHistory();
};
