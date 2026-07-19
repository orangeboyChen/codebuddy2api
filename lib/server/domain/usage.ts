import crypto from 'node:crypto';

import { listAccessKeys } from './access-keys';
import { listCredentialFilenames } from './credentials';
import {
  appendStorageUsageEvents,
  clearStorageUsageEvents,
  getStorageBackendMeta,
  listStorageUsageEvents,
  readStorageJson,
  trimStorageUsageEvents,
  writeStorageJson,
} from '../storage';

export type UsageRange =
  '1h' | '3h' | '6h' | '12h' | '24h' | '3d' | '7d' | 'today' | 'yesterday';

export interface UsageSnapshot {
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_creation_tokens?: number | null;
  } | null;
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

export interface CredentialUsageRow extends UsageBucketTotals {
  credentialFilename: string;
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
  credentialCallCounts: Record<string, number>;
  credentialRows: CredentialUsageRow[];
  filters: UsageFilterOptions;
  range: UsageRange;
  rangeSummary: UsageSummary;
  tableRows: UsageTableRow[];
  tokenSeries: UsageChartSeries[];
}

const USAGE_NAMESPACE = 'usage';
const USAGE_STORE_KEY = 'history';
const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FLUSH_INTERVAL_MS = 1000;
const MAX_PENDING_EVENTS = 100;
const RETENTION_PRUNE_INTERVAL_MS = HOUR_MS;
let usageMutationQueue: Promise<void> = Promise.resolve();
let pendingUsageEvents: UsageEventRecord[] = [];
let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
let lastUsageRetentionPruneAt = 0;

const enqueueUsageMutation = async <T>(
  mutation: () => Promise<T>,
): Promise<T> => {
  const operation = usageMutationQueue.then(mutation, mutation);
  usageMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
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
  const promptTokenDetails = usage.prompt_tokens_details;
  const cacheReadTokens = toNumber(
    usage.cache_read_input_tokens ?? promptTokenDetails?.cached_tokens,
  );
  const cacheCreationTokens = toNumber(
    usage.cache_creation_input_tokens ??
      promptTokenDetails?.cache_creation_tokens,
  );
  const explicitTotal = toNumber(usage.total_tokens);
  const totalTokens =
    explicitTotal ||
    inputTokens +
      outputTokens +
      (promptTokenDetails ? 0 : cacheReadTokens + cacheCreationTokens);

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

const normalizeStoredEvent = (value: unknown): UsageEventRecord | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<UsageEventRecord>;

  if (
    typeof record.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(record.timestamp)) ||
    typeof record.model !== 'string' ||
    typeof record.route !== 'string'
  ) {
    return null;
  }

  return {
    accessKeyId:
      typeof record.accessKeyId === 'string' ? record.accessKeyId : null,
    accessKeyName:
      typeof record.accessKeyName === 'string' ? record.accessKeyName : null,
    cacheCreationTokens: toNumber(record.cacheCreationTokens),
    cacheReadTokens: toNumber(record.cacheReadTokens),
    callCount: Math.max(1, Math.floor(toNumber(record.callCount) || 1)),
    credentialFilename:
      typeof record.credentialFilename === 'string'
        ? record.credentialFilename
        : null,
    inputTokens: toNumber(record.inputTokens),
    model: record.model.trim() || 'unknown',
    outputTokens: toNumber(record.outputTokens),
    route: record.route,
    timestamp: record.timestamp,
    totalTokens: toNumber(record.totalTokens),
  };
};

const normalizeUsageStore = (value: unknown): UsageStore => {
  if (!value || typeof value !== 'object') {
    return { events: [] };
  }

  const record = value as Partial<UsageStore>;
  const events = Array.isArray(record.events)
    ? record.events
        .map((event) => normalizeStoredEvent(event))
        .filter((event): event is UsageEventRecord => event !== null)
    : [];

  return { events };
};

const trimExpiredEvents = (
  events: UsageEventRecord[],
  nowMs: number,
): UsageEventRecord[] => {
  return events.filter((event) => {
    const timestampMs = Date.parse(event.timestamp);

    if (!Number.isFinite(timestampMs)) {
      return false;
    }

    return nowMs - timestampMs <= MAX_RETENTION_MS;
  });
};

const readUsageStore = async (): Promise<UsageStore> => {
  if (getStorageBackendMeta().backend !== 'file') {
    const events = await listStorageUsageEvents(
      new Date(Date.now() - MAX_RETENTION_MS),
    );
    return {
      events: events
        .map((event) => normalizeStoredEvent(event.payload))
        .filter((event): event is UsageEventRecord => event !== null),
    };
  }

  const store = await readStorageJson<UsageStore>(
    USAGE_NAMESPACE,
    USAGE_STORE_KEY,
  );
  return normalizeUsageStore(store);
};

const writeUsageStore = async (store: UsageStore): Promise<void> => {
  await writeStorageJson(USAGE_NAMESPACE, USAGE_STORE_KEY, store);
};

const persistTrimmedStore = async (nowMs: number): Promise<UsageStore> => {
  const store = await readUsageStore();
  const trimmedEvents = trimExpiredEvents(store.events, nowMs);

  if (
    getStorageBackendMeta().backend === 'file' &&
    trimmedEvents.length !== store.events.length
  ) {
    await writeUsageStore({
      events: trimmedEvents,
    });
  }

  return {
    events: trimmedEvents,
  };
};

const flushPendingUsageEvents = async (): Promise<void> => {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }

  const events = pendingUsageEvents.splice(0, MAX_PENDING_EVENTS);

  if (!events.length) return;

  try {
    await enqueueUsageMutation(async () => {
      const nowMs = Date.now();

      if (getStorageBackendMeta().backend !== 'file') {
        await appendStorageUsageEvents(
          events.map((event) => ({
            id: crypto.randomUUID(),
            payload: event,
            timestamp: event.timestamp,
          })),
        );
        if (nowMs - lastUsageRetentionPruneAt >= RETENTION_PRUNE_INTERVAL_MS) {
          await trimStorageUsageEvents(new Date(nowMs - MAX_RETENTION_MS));
          lastUsageRetentionPruneAt = nowMs;
        }
        if (pendingUsageEvents.length) {
          scheduleUsageFlush();
        }
        return;
      }

      const store = await persistTrimmedStore(nowMs);
      await writeUsageStore({
        events: trimExpiredEvents([...store.events, ...events], nowMs),
      });
      if (pendingUsageEvents.length) {
        scheduleUsageFlush();
      }
    });
  } catch (error) {
    pendingUsageEvents = [...events, ...pendingUsageEvents];
    scheduleUsageFlush();
    throw error;
  }
};

const scheduleUsageFlush = (): void => {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    void flushPendingUsageEvents().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  usageFlushTimer.unref?.();
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

  const rollingWindows: Partial<
    Record<UsageRange, { bucketCount: number; bucketSizeMs: number }>
  > = {
    '1h': { bucketCount: 12, bucketSizeMs: FIVE_MINUTES_MS },
    '3h': { bucketCount: 12, bucketSizeMs: 15 * 60 * 1000 },
    '6h': { bucketCount: 12, bucketSizeMs: 30 * 60 * 1000 },
    '12h': { bucketCount: 12, bucketSizeMs: HOUR_MS },
    '24h': { bucketCount: 24, bucketSizeMs: HOUR_MS },
  };

  if (range === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    return {
      bucketCount: 24,
      bucketSizeMs: HOUR_MS,
      endMs: end.getTime(),
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

  if (range === '3d' || range === '7d') {
    const bucketCount = range === '3d' ? 3 : 7;
    const currentDay = new Date(now);
    currentDay.setHours(0, 0, 0, 0);
    const endMs = currentDay.getTime() + DAY_MS;

    return {
      bucketCount,
      bucketSizeMs: DAY_MS,
      endMs,
      startMs: endMs - bucketCount * DAY_MS,
    };
  }

  const rollingWindow = rollingWindows[range];

  if (!rollingWindow) {
    throw new Error(`Unsupported usage range: ${range}`);
  }

  const currentBucketStart =
    Math.floor(nowMs / rollingWindow.bucketSizeMs) * rollingWindow.bucketSizeMs;

  return {
    bucketCount: rollingWindow.bucketCount,
    bucketSizeMs: rollingWindow.bucketSizeMs,
    endMs: currentBucketStart + rollingWindow.bucketSizeMs,
    startMs:
      currentBucketStart -
      (rollingWindow.bucketCount - 1) * rollingWindow.bucketSizeMs,
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

const matchesFilter = (
  event: UsageEventRecord,
  accessKey: string | string[],
  credential: string | string[],
): boolean => {
  const accessKeys = Array.isArray(accessKey) ? accessKey : [accessKey];
  const credentials = Array.isArray(credential) ? credential : [credential];

  if (
    accessKeys.length > 0 &&
    !accessKeys.includes('all') &&
    !accessKeys.includes(event.accessKeyId ?? '')
  ) {
    return false;
  }

  if (
    credentials.length > 0 &&
    !credentials.includes('all') &&
    !credentials.includes(event.credentialFilename ?? '')
  ) {
    return false;
  }

  return true;
};

const createEmptyTotals = (): UsageBucketTotals => ({
  callCount: 0,
  cacheHitTokens: 0,
  totalTokens: 0,
});

const createEmptyBucketTotals = (count: number): UsageBucketTotals[] => {
  return Array.from({ length: count }, () => createEmptyTotals());
};

const addEventToTotals = (
  totals: UsageBucketTotals,
  event: UsageEventRecord,
): UsageBucketTotals => ({
  callCount: totals.callCount + event.callCount,
  cacheHitTokens: totals.cacheHitTokens + event.cacheReadTokens,
  totalTokens: totals.totalTokens + event.totalTokens,
});

const mergeFilterOptions = (
  current: UsageFilterOption[],
  history: UsageFilterOption[],
): UsageFilterOption[] => {
  const merged = new Map<string, UsageFilterOption>();

  [...current, ...history].forEach((item) => {
    if (!item.value.trim() || merged.has(item.value)) {
      return;
    }

    merged.set(item.value, item);
  });

  return [...merged.values()];
};

export const recordUsageEvent = async ({
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
}): Promise<void> => {
  if (!usage) {
    return;
  }

  const base = normalizeUsage(usage);
  pendingUsageEvents.push({
    ...base,
    accessKeyId: accessKeyId ?? null,
    accessKeyName: accessKeyName ?? null,
    credentialFilename: credentialFilename ?? null,
    model: model.trim() || 'unknown',
    route,
    timestamp: timestamp ?? new Date().toISOString(),
  });

  if (pendingUsageEvents.length >= MAX_PENDING_EVENTS) {
    void flushPendingUsageEvents().catch(() => undefined);
    return;
  }

  scheduleUsageFlush();
};

export const clearUsageHistory = async (): Promise<void> => {
  pendingUsageEvents = [];
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  await enqueueUsageMutation(async () => {
    if (getStorageBackendMeta().backend !== 'file') {
      await clearStorageUsageEvents();
      return;
    }
    await writeUsageStore({
      events: [],
    });
  });
};

export const getUsageAnalytics = async ({
  accessKey = 'all',
  credential = 'all',
  now = new Date(),
  range,
}: {
  accessKey?: string | string[];
  credential?: string | string[];
  now?: Date;
  range: UsageRange;
}): Promise<UsageAnalyticsResponse> => {
  await flushPendingUsageEvents();
  return enqueueUsageMutation(async () => {
    const nowMs = now.getTime();
    const store = await persistTrimmedStore(nowMs);
    const buckets = buildBuckets(range, now);
    const tokenSeriesByModel = new Map<string, UsageBucketTotals[]>();
    const callSeriesByModel = new Map<string, UsageBucketTotals[]>();
    const tableRowsByModel = new Map<string, UsageBucketTotals>();
    const credentialRowsByFilename = new Map<string, UsageBucketTotals>();
    const credentialCallCounts: Record<string, number> = {};
    const rangeSummary = createEmptyTotals();
    const { endMs, startMs } = getRangeWindow(range, now);

    store.events.forEach((event) => {
      const eventMs = Date.parse(event.timestamp);

      if (!Number.isFinite(eventMs)) {
        return;
      }

      if (!matchesFilter(event, accessKey, credential)) {
        return;
      }

      if (event.credentialFilename) {
        credentialCallCounts[event.credentialFilename] =
          (credentialCallCounts[event.credentialFilename] ?? 0) +
          event.callCount;
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
        createEmptyBucketTotals(buckets.length);
      const callBuckets =
        callSeriesByModel.get(event.model) ??
        createEmptyBucketTotals(buckets.length);
      const tableTotals =
        tableRowsByModel.get(event.model) ?? createEmptyTotals();

      const nextRangeSummary = addEventToTotals(rangeSummary, event);
      rangeSummary.callCount = nextRangeSummary.callCount;
      rangeSummary.cacheHitTokens = nextRangeSummary.cacheHitTokens;
      rangeSummary.totalTokens = nextRangeSummary.totalTokens;

      if (event.credentialFilename) {
        const credentialTotals =
          credentialRowsByFilename.get(event.credentialFilename) ??
          createEmptyTotals();
        credentialRowsByFilename.set(
          event.credentialFilename,
          addEventToTotals(credentialTotals, event),
        );
      }

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
    ): UsageChartSeries[] => {
      return [...modelMap.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([model, points]) => ({
          model,
          points: points.map((point, index) => ({
            callCount: point.callCount,
            cacheHitTokens: point.cacheHitTokens,
            label: buckets[index].label,
            start: buckets[index].start,
            totalTokens: point.totalTokens,
          })),
        }));
    };

    const accessKeys = await listAccessKeys();
    const credentialFilenames = await listCredentialFilenames();
    const accessKeyHistoryOptions = [...store.events]
      .filter(
        (
          event,
        ): event is UsageEventRecord & {
          accessKeyId: string;
          accessKeyName: string;
        } =>
          typeof event.accessKeyId === 'string' &&
          event.accessKeyId.length > 0 &&
          typeof event.accessKeyName === 'string' &&
          event.accessKeyName.length > 0,
      )
      .map((event) => ({
        label: event.accessKeyName,
        value: event.accessKeyId,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));

    const credentialHistoryOptions = [
      ...new Set(
        store.events
          .map((event) => event.credentialFilename)
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.length > 0,
          ),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map((value) => ({
        label: value,
        value,
      }));

    return {
      callSeries: toSeries(callSeriesByModel),
      credentialCallCounts,
      credentialRows: [...credentialRowsByFilename.entries()]
        .map(([credentialFilename, totals]) => ({
          ...totals,
          credentialFilename,
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      filters: {
        accessKeys: mergeFilterOptions(
          [
            {
              label: '全部 API Key',
              value: 'all',
            },
            ...accessKeys.access_keys.map((item) => ({
              label: item.name,
              value: item.id,
            })),
          ],
          accessKeyHistoryOptions,
        ),
        credentials: mergeFilterOptions(
          [
            {
              label: '全部凭据',
              value: 'all',
            },
            ...credentialFilenames.map((filename) => ({
              label: filename,
              value: filename,
            })),
          ],
          credentialHistoryOptions,
        ),
      },
      range,
      rangeSummary,
      tableRows: [...tableRowsByModel.entries()]
        .map(([model, totals]) => ({
          ...totals,
          model,
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens),
      tokenSeries: toSeries(tokenSeriesByModel),
    };
  });
};

export const resetUsageHistory = async (): Promise<void> => {
  await clearUsageHistory();
};
