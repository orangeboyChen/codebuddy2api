'use client';

import { Block, Flexbox, Input, Tag } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import {
  Bot,
  Braces,
  Clock3,
  Copy,
  Database,
  Gauge,
  Info,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Save,
  Server,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { atom } from 'jotai';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useState } from 'react';

export interface DebugLogEntry {
  credentialFilename: string | null;
  createdAt: string;
  error: string | null;
  id: string;
  requestBody: unknown;
  requestKey: string | null;
  route: string;
  transformedResponse: {
    body: unknown;
    headers: Record<string, string>;
    status: number;
  } | null;
  upstreamRequest: {
    body?: unknown;
    headers?: Record<string, string>;
    method: string;
    url: string;
  } | null;
  upstreamResponse: {
    body?: unknown;
    headers?: Record<string, string>;
    status: number;
  } | null;
  elapsedMs?: number;
  model?: string | null;
  usage?: {
    cacheCreationTokens: number;
    cacheReadTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
}

export interface DebugState {
  autoRefreshSeconds: number;
  detailLoadedIds: Record<string, boolean>;
  detailLoadingIds: Record<string, boolean>;
  enabled: boolean;
  items: DebugLogEntry[];
  loading: boolean;
  maxEntries: number;
  saving: boolean;
}

export interface AdminDebugSnapshot {
  autoRefreshSeconds: number;
  enabled: boolean;
  items?: DebugLogEntry[];
  maxEntries: number;
}

export const defaultDebugState: DebugState = {
  autoRefreshSeconds: 0,
  detailLoadedIds: {},
  detailLoadingIds: {},
  enabled: false,
  items: [],
  loading: true,
  maxEntries: 10,
  saving: false,
};

export const debugStateAtom = atom<DebugState>(defaultDebugState);

export const createDebugState = (initialData: {
  debug: AdminDebugSnapshot;
}): DebugState => {
  return {
    autoRefreshSeconds: initialData.debug.autoRefreshSeconds,
    detailLoadedIds: {},
    detailLoadingIds: {},
    enabled: initialData.debug.enabled,
    items: initialData.debug.items ?? [],
    loading: !initialData.debug.items,
    maxEntries: initialData.debug.maxEntries,
    saving: false,
  };
};

export interface DebugController {
  autoRefreshOptions: Array<{ label: string; value: number }>;
  debug: DebugState;
  onAutoRefreshSecondsChange: (value: number) => void;
  onClear: () => void;
  onCopy: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onMaxEntriesChange: (value: number) => void;
  onLoadDetail?: (id: string) => void;
  onRefresh: () => void;
  onSave: () => void;
}

const DebugContext = createContext<DebugController | null>(null);
export const DebugProvider = DebugContext.Provider;

const useDebug = (): DebugController => {
  const controller = useContext(DebugContext);
  if (!controller) throw new Error('Debug controller is unavailable');
  return controller;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseSseEvents = (value: unknown): string[] | null => {
  if (typeof value !== 'string' || !/(?:^|\n)data:/.test(value)) {
    return null;
  }

  const events = value
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n'),
    )
    .filter(Boolean);

  return events.length ? events : null;
};

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null, null, 2);
};

const formatDuration = (elapsedMs: number): string => {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }

  const seconds = elapsedMs / 1_000;

  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

const getText = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(getText)
      .filter((item): item is string => Boolean(item))
      .join('');
  }
  if (!isRecord(value)) return null;
  for (const key of ['text', 'content', 'value', 'delta']) {
    const text = getText(value[key]);
    if (text) return text;
  }
  return null;
};

const getToolName = (tool: JsonRecord): string => {
  const functionValue = isRecord(tool.function) ? tool.function : tool;
  return String(functionValue.name ?? tool.name ?? 'Unnamed tool');
};

const isMcpTool = (tool: JsonRecord): boolean => {
  const serialized = JSON.stringify(tool).toLowerCase();
  return (
    tool.type === 'mcp' ||
    serialized.includes('mcp_') ||
    serialized.includes('mcp')
  );
};

const RawPayload = ({
  onCopy,
  value,
}: {
  onCopy: (value: string) => void;
  value: unknown;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 border-t border-border-light dark:border-border-dark pt-3">
      <Button
        icon={Braces}
        onClick={() => setOpen((current) => !current)}
        size="small"
      >
        {open ? 'Hide raw' : 'View raw'}
      </Button>
      {open ? <RawPayloadContent onCopy={onCopy} value={value} /> : null}
    </div>
  );
};

const RawPayloadContent = ({
  onCopy,
  value,
}: {
  onCopy: (value: string) => void;
  value: unknown;
}) => {
  // This intentionally happens only after the operator asks for raw data.
  const content = formatValue(value);
  const sseEvents = parseSseEvents(value);

  return (
    <div className="mt-3 grid gap-3">
      <div className="flex justify-end">
        <Button icon={Copy} onClick={() => onCopy(content)} size="small">
          Copy
        </Button>
      </div>
      {sseEvents ? (
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-xs">
            <thead>
              <tr>
                <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  Event
                </th>
                <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  Data
                </th>
              </tr>
            </thead>
            <tbody>
              {sseEvents.map((event, index) => (
                <tr key={`${index}-${event.slice(0, 32)}`}>
                  <td className="p-3 align-top border-b border-border-light dark:border-border-dark text-secondary">
                    {index + 1}
                  </td>
                  <td className="p-3 border-b border-border-light dark:border-border-dark">
                    <pre className="whitespace-pre-wrap break-all text-text-light dark:text-text-dark">
                      {formatValue(parseJsonValue(event))}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className="w-full overflow-x-auto whitespace-pre-wrap break-all text-xs text-text-light dark:text-text-dark">
          {content}
        </pre>
      )}
    </div>
  );
};

const DebugMetric = ({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Info;
  label: string;
  value: string | number | null | undefined;
}) => {
  if (value === null || value === undefined || value === '') return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-secondary"
      title={label}
    >
      <Icon aria-hidden="true" size={14} />
      <span>{label}</span>
      <span>{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </span>
  );
};

const StructuredUpstreamRequest = ({
  onCopy,
  title,
  value,
}: {
  onCopy: (value: string) => void;
  title: string;
  value: unknown;
}) => {
  const [showAllMessages, setShowAllMessages] = useState(false);
  const request = parseJsonValue(value);
  const record = isRecord(request) ? request : null;
  const tools = Array.isArray(record?.tools)
    ? record.tools.filter(isRecord)
    : [];
  const messages = Array.isArray(record?.messages)
    ? record.messages
    : Array.isArray(record?.input)
      ? record.input
      : [];
  const displayedMessages = showAllMessages ? messages : messages.slice(-1);

  return (
    <Block
      className="debug-payload w-full min-w-0"
      padding={12}
      variant="outlined"
    >
      <div className="flex items-center gap-2 font-medium text-text-light dark:text-text-dark">
        {title}
      </div>
      {record ? (
        <div className="mt-3 grid gap-4 text-sm">
          {tools.length ? (
            <div>
              <div className="mb-2 flex items-center gap-2 font-medium">
                <Wrench aria-hidden="true" size={16} /> Tools ({tools.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-xs">
                  <thead className="text-secondary">
                    <tr>
                      <th className="p-2 text-left">Name</th>
                      <th className="p-2 text-left">Type</th>
                      <th className="p-2 text-left">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((tool, index) => {
                      const functionValue = isRecord(tool.function)
                        ? tool.function
                        : tool;
                      return (
                        <tr
                          key={`${getToolName(tool)}-${index}`}
                          className="border-t border-border-light dark:border-border-dark"
                        >
                          <td className="p-2 font-medium">
                            <span className="inline-flex items-center gap-1">
                              {isMcpTool(tool) ? (
                                <Server aria-label="MCP tool" size={14} />
                              ) : null}
                              {getToolName(tool)}
                            </span>
                          </td>
                          <td className="p-2 text-secondary">
                            {String(tool.type ?? 'function')}
                          </td>
                          <td className="p-2 text-secondary">
                            {String(functionValue.description ?? '-')}
                          </td>
                          <td className="p-2">
                            <details>
                              <summary className="cursor-pointer text-primary">
                                Parameters
                              </summary>
                              <pre className="mt-2 max-w-[420px] overflow-x-auto whitespace-pre-wrap break-all">
                                {formatValue(
                                  functionValue.parameters ??
                                    tool.parameters ??
                                    {},
                                )}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-2 flex items-center gap-2 font-medium">
              <MessageSquareText aria-hidden="true" size={16} /> Messages (
              {messages.length})
            </div>
            {messages.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-xs">
                  <thead className="text-secondary">
                    <tr>
                      <th className="p-2 text-left">Role</th>
                      <th className="p-2 text-left">Content</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedMessages.map((message, index) => {
                      const item: JsonRecord = isRecord(message)
                        ? message
                        : { content: message };
                      return (
                        <tr
                          className="border-t border-border-light dark:border-border-dark"
                          key={index}
                        >
                          <td className="p-2 align-top font-medium">
                            {String(item.role ?? 'input')}
                          </td>
                          <td className="p-2 whitespace-pre-wrap break-words">
                            {getText(item.content) ??
                              formatValue(item.content ?? item)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {messages.length > 1 && !showAllMessages ? (
                  <Button
                    className="mt-2"
                    onClick={() => setShowAllMessages(true)}
                    size="small"
                  >
                    Show all messages
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-secondary">No messages</div>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 text-sm text-secondary">
          No structured request data
        </div>
      )}
      <RawPayload onCopy={onCopy} value={value} />
    </Block>
  );
};

const StructuredUpstreamResponse = ({
  onCopy,
  value,
}: {
  onCopy: (value: string) => void;
  value: unknown;
}) => {
  const sseEvents = parseSseEvents(value);
  const parsed = parseJsonValue(value);
  const eventPayloads = sseEvents?.map(parseJsonValue) ?? [];
  const response = (eventPayloads.at(-1) ?? parsed) as unknown;
  const responseRecord = isRecord(response) ? response : null;
  const content =
    eventPayloads
      .map((event) => (isRecord(event) ? getText(event.choices) : null))
      .filter((item): item is string => Boolean(item))
      .join('') ||
    getText(responseRecord?.choices) ||
    getText(responseRecord?.content);
  const usage = isRecord(responseRecord?.usage) ? responseRecord.usage : null;

  return (
    <Block
      className="debug-payload w-full min-w-0"
      padding={12}
      variant="outlined"
    >
      <div className="flex items-center gap-2 font-medium text-text-light dark:text-text-dark">
        Upstream response
        {sseEvents ? (
          <Tag variant="borderless">SSE · {sseEvents.length} events</Tag>
        ) : null}
      </div>
      <div className="mt-3 grid gap-3 text-sm">
        <div className="flex flex-wrap gap-4 text-secondary">
          <DebugMetric
            icon={Bot}
            label="Model"
            value={responseRecord?.model as string | undefined}
          />
          <DebugMetric
            icon={Database}
            label="Input tokens"
            value={usage?.prompt_tokens as number | undefined}
          />
          <DebugMetric
            icon={Sparkles}
            label="Output tokens"
            value={usage?.completion_tokens as number | undefined}
          />
          <DebugMetric
            icon={Gauge}
            label="Total tokens"
            value={usage?.total_tokens as number | undefined}
          />
        </div>
        {content ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-text-light dark:text-text-dark">
            {content}
          </pre>
        ) : (
          <div className="text-xs text-secondary">
            No aggregate response content
          </div>
        )}
      </div>
      <RawPayload onCopy={onCopy} value={value} />
    </Block>
  );
};

const RawDebugSection = ({
  onCopy,
  title,
  value,
}: {
  onCopy: (value: string) => void;
  title: string;
  value: unknown;
}) => {
  return (
    <Block
      className="debug-payload w-full min-w-0"
      padding={12}
      variant="outlined"
    >
      <div className="font-medium text-text-light dark:text-text-dark">
        {title}
      </div>
      <RawPayload onCopy={onCopy} value={value} />
    </Block>
  );
};

const SectionTitle = ({
  icon: Icon,
  title,
}: {
  icon: typeof Info;
  title: string;
}) => {
  return (
    <Flexbox align="center" gap={8} horizontal>
      <Icon aria-hidden="true" size={18} strokeWidth={2} />
      <h3 className="section-title">{title}</h3>
    </Flexbox>
  );
};

const ToggleOption = ({
  checked,
  description,
  onChange,
  title,
}: {
  checked: boolean;
  description: string;
  onChange: (checked: boolean) => void;
  title: string;
}) => {
  return (
    <Block
      align="center"
      className="toggle-option"
      distribution="space-between"
      gap={16}
      horizontal
      onClick={(event) => {
        if ((event.target as Element).closest('button')) return;
        onChange(!checked);
      }}
      padding={12}
      variant="outlined"
    >
      <div>
        <div className="font-medium text-text-light dark:text-text-dark">
          {title}
        </div>
        <div className="text-sm text-secondary">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} />
    </Block>
  );
};

const Debug = () => {
  const {
    autoRefreshOptions,
    debug,
    onAutoRefreshSecondsChange,
    onClear,
    onCopy,
    onEnabledChange,
    onLoadDetail,
    onMaxEntriesChange,
    onRefresh,
    onSave,
  } = useDebug();
  const debugText = useTranslations('Admin.debug');
  const formatCreatedAt = (createdAt: string) => {
    const date = new Date(createdAt);

    return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString();
  };

  return (
    <div id="debug" className="block">
      <Block
        className="debug-section"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="debug-section-header flex items-center justify-between">
          <SectionTitle icon={Info} title={debugText('sectionTitle')} />
          <div className="debug-section-actions flex gap-2">
            <div className="min-w-[160px]">
              <label className="sr-only" htmlFor="debugAutoRefreshSeconds">
                {debugText('refreshInterval')}
              </label>
              <Select
                disabled={!debug.enabled || debug.saving}
                id="debugAutoRefreshSeconds"
                onChange={(value) =>
                  onAutoRefreshSecondsChange(
                    Number.parseInt(String(value), 10) || 0,
                  )
                }
                options={autoRefreshOptions}
                value={debug.autoRefreshSeconds}
              />
            </div>
            <Button icon={RefreshCw} onClick={onRefresh}>
              {debugText('refresh')}
            </Button>
            <Button
              danger
              disabled={debug.saving}
              icon={Trash2}
              onClick={onClear}
            >
              {debugText('clear')}
            </Button>
          </div>
        </div>
        <div className="debug-settings-grid grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_auto] items-end mb-6">
          <ToggleOption
            checked={debug.enabled}
            description={debugText('enableHelp')}
            onChange={onEnabledChange}
            title={debugText('enable')}
          />
          <div>
            <label
              className="block mb-2 font-medium text-text-light dark:text-text-dark"
              htmlFor="debugMaxEntries"
            >
              {debugText('maxEntries')}
            </label>
            <Input
              id="debugMaxEntries"
              min={1}
              onChange={(event) =>
                onMaxEntriesChange(
                  Number.parseInt(event.target.value || '0', 10) || 1,
                )
              }
              type="number"
              value={debug.maxEntries}
            />
          </div>
          <Button
            disabled={debug.saving}
            icon={Save}
            loading={debug.saving}
            onClick={onSave}
            type="primary"
          >
            {debugText('save')}
          </Button>
        </div>
        {debug.items.length ? (
          <div className="grid gap-4 w-full min-w-0">
            {debug.items.map((item) => (
              <Block
                as="details"
                key={item.id}
                className="debug-entry w-full min-w-0 max-w-full"
                onToggle={(event) => {
                  if (
                    (event.target as HTMLDetailsElement).open &&
                    !debug.detailLoadedIds[item.id] &&
                    !debug.detailLoadingIds[item.id]
                  ) {
                    onLoadDetail?.(item.id);
                  }
                }}
                padding={16}
                variant="outlined"
              >
                <summary className="debug-entry-summary cursor-pointer list-none p-4 grid items-start gap-3 w-full min-w-0 max-w-full overflow-hidden text-left">
                  <div className="font-medium text-text-light dark:text-text-dark break-words text-left">
                    {item.route}
                  </div>
                  <div className="flex flex-wrap items-start gap-2 text-xs min-w-0 max-w-full">
                    <Tag className="!px-0" variant="borderless">
                      {debugText('credential')}:{' '}
                      {item.credentialFilename ??
                        debugText('credentialUnknown')}
                    </Tag>
                    {item.error ? (
                      <Tag color="red" variant="borderless">
                        {item.error}
                      </Tag>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-2 text-xs min-w-0 max-w-full">
                    <Tag className="!px-0" variant="borderless">
                      {debugText('upstreamStatus', {
                        value: item.upstreamResponse?.status ?? '-',
                      })}
                    </Tag>
                    <Tag className="!px-0" variant="borderless">
                      {debugText('returnedStatus', {
                        value: item.transformedResponse?.status ?? '-',
                      })}
                    </Tag>
                  </div>
                  <div className="text-sm text-secondary break-all min-w-0 max-w-full text-left">
                    {formatCreatedAt(item.createdAt)} · key:{' '}
                    {item.requestKey ?? debugText('requestKeyNone')}
                  </div>
                  <div className="debug-entry-tags flex flex-wrap items-start gap-x-5 gap-y-2 text-xs min-w-0 max-w-full text-left">
                    <DebugMetric icon={Bot} label="Model" value={item.model} />
                    <DebugMetric
                      icon={Database}
                      label="Input tokens"
                      value={item.usage?.inputTokens}
                    />
                    <DebugMetric
                      icon={Sparkles}
                      label="Output tokens"
                      value={item.usage?.outputTokens}
                    />
                    <DebugMetric
                      icon={Database}
                      label="Cached tokens"
                      value={
                        (item.usage?.cacheReadTokens ?? 0) +
                        (item.usage?.cacheCreationTokens ?? 0)
                      }
                    />
                    <DebugMetric
                      icon={Gauge}
                      label="TPS"
                      value={
                        item.elapsedMs && item.usage?.totalTokens
                          ? Math.round(
                              (item.usage.totalTokens * 1_000) / item.elapsedMs,
                            )
                          : null
                      }
                    />
                    <DebugMetric
                      icon={Clock3}
                      label="Request duration"
                      value={
                        item.elapsedMs === undefined
                          ? null
                          : formatDuration(item.elapsedMs)
                      }
                    />
                  </div>
                </summary>
                <div className="debug-entry-content p-4 pt-0 grid gap-4 w-full min-w-0">
                  {!debug.detailLoadedIds[item.id] ? (
                    <div className="text-sm text-secondary">
                      Loading trace detail...
                    </div>
                  ) : (
                    <>
                      <RawDebugSection
                        onCopy={onCopy}
                        title={debugText('request')}
                        value={item.requestBody}
                      />
                      <StructuredUpstreamRequest
                        onCopy={onCopy}
                        title={debugText('upstreamRequest')}
                        value={item.upstreamRequest?.body}
                      />
                      <StructuredUpstreamResponse
                        onCopy={onCopy}
                        value={item.upstreamResponse?.body}
                      />
                      <RawDebugSection
                        onCopy={onCopy}
                        title={debugText('response')}
                        value={item.transformedResponse?.body}
                      />
                    </>
                  )}
                </div>
              </Block>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-8 text-secondary">
            {debug.loading ? (
              <>
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  size={18}
                />
                <span>{debugText('loading')}</span>
              </>
            ) : (
              debugText('empty')
            )}
          </div>
        )}
      </Block>
    </div>
  );
};

export default Debug;
