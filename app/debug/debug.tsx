'use client';

import {
  Block,
  Collapse,
  Flexbox,
  Highlighter,
  Input,
  List,
  Snippet,
  Tag,
} from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import {
  Bot,
  Braces,
  Clock3,
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
  elapsedMs?: number | null;
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

const hasDuration = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
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

const getStreamingEventText = (event: unknown): string | null => {
  if (!isRecord(event)) return null;

  const choiceText = getText(event.choices);
  if (choiceText) return choiceText;

  return event.type === 'response.output_text.delta'
    ? getText(event.delta)
    : null;
};

const getToolName = (tool: JsonRecord): string => {
  const functionValue = isRecord(tool.function) ? tool.function : tool;
  return String(functionValue.name ?? tool.name ?? 'Unnamed tool');
};

const formatRole = (value: unknown): string => {
  const role = String(value ?? 'input');
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
};

const isMcpTool = (tool: JsonRecord): boolean => {
  const serialized = JSON.stringify(tool).toLowerCase();
  return (
    tool.type === 'mcp' ||
    serialized.includes('mcp_') ||
    serialized.includes('mcp')
  );
};

const RawPayload = ({ value }: { value: unknown }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <Button
        icon={Braces}
        onClick={() => setOpen((current) => !current)}
        size="small"
      >
        {open ? 'Hide raw' : 'View raw'}
      </Button>
      {open ? <RawPayloadContent value={value} /> : null}
    </div>
  );
};

const RawPayloadContent = ({ value }: { value: unknown }) => {
  // This intentionally happens only after the operator asks for raw data.
  const content = formatValue(value);
  const sseEvents = parseSseEvents(value);

  return (
    <div className="mt-3 grid gap-3">
      {sseEvents ? (
        <Collapse
          className="debug-raw-events w-full min-w-0"
          defaultActiveKey={sseEvents.map(
            (event, index) => `${index}-${event.slice(0, 32)}`,
          )}
          items={sseEvents.map((event, index) => ({
            children: (
              <Highlighter
                className="debug-raw-code"
                language="json"
                showLanguage={false}
                variant="outlined"
              >
                {formatValue(parseJsonValue(event))}
              </Highlighter>
            ),
            key: `${index}-${event.slice(0, 32)}`,
            label: `Event ${index + 1}`,
          }))}
          padding={{ body: 12, header: 12 }}
          variant="outlined"
        />
      ) : (
        <Highlighter
          className="debug-raw-code"
          language="json"
          showLanguage={false}
          variant="outlined"
        >
          {content}
        </Highlighter>
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
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 text-xs text-secondary"
      title={label}
    >
      <Icon aria-hidden="true" size={14} />
      <span className="break-words">{label}</span>
      <span className="break-all">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </span>
  );
};

const StructuredUpstreamRequest = ({
  title,
  value,
}: {
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
              <List
                className="debug-tool-list"
                classNames={{
                  container: 'debug-tool-item-content',
                  item: 'debug-tool-item',
                }}
                items={tools.map((tool, index) => {
                  const functionValue = isRecord(tool.function)
                    ? tool.function
                    : tool;
                  return {
                    addon: (
                      <Collapse
                        items={[
                          {
                            children: (
                              <Snippet language="json" variant="outlined">
                                {formatValue(
                                  functionValue.parameters ??
                                    tool.parameters ??
                                    {},
                                )}
                              </Snippet>
                            ),
                            key: 'parameters',
                            label: 'Parameters',
                          },
                        ]}
                        padding={8}
                        variant="borderless"
                      />
                    ),
                    description: `${String(tool.type ?? 'function')} - ${String(
                      functionValue.description ?? 'No description',
                    )}`,
                    key: `${getToolName(tool)}-${index}`,
                    title: (
                      <span className="inline-flex items-center gap-1">
                        {isMcpTool(tool) ? (
                          <Server aria-label="MCP tool" size={14} />
                        ) : null}
                        {getToolName(tool)}
                      </span>
                    ),
                  };
                })}
                padding={0}
              />
            </div>
          ) : null}
          <Flexbox className="debug-messages-section" gap={8} padding={12}>
            <div className="flex items-center gap-2 font-medium">
              <MessageSquareText aria-hidden="true" size={16} /> Messages (
              {messages.length})
            </div>
            {messages.length ? (
              <Flexbox className="debug-message-list" gap={8} padding={12}>
                {displayedMessages.map((message, index) => {
                  const item: JsonRecord = isRecord(message)
                    ? message
                    : { content: message };
                  return (
                    <Flexbox
                      className="debug-message-row"
                      gap={12}
                      horizontal
                      key={`${String(item.role ?? 'input')}-${index}`}
                      padding={12}
                    >
                      <div className="debug-message-role text-sm font-medium text-secondary">
                        {formatRole(item.role)}
                      </div>
                      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-text-light dark:text-text-dark">
                        {getText(item.content) ??
                          formatValue(item.content ?? item)}
                      </div>
                    </Flexbox>
                  );
                })}
                {messages.length > 1 && !showAllMessages ? (
                  <Button onClick={() => setShowAllMessages(true)} size="small">
                    Show all messages
                  </Button>
                ) : null}
              </Flexbox>
            ) : (
              <div className="text-xs text-secondary">No messages</div>
            )}
          </Flexbox>
        </div>
      ) : (
        <div className="mt-3 text-sm text-secondary">
          No structured request data
        </div>
      )}
      <RawPayload value={value} />
    </Block>
  );
};

const StructuredUpstreamResponse = ({ value }: { value: unknown }) => {
  const sseEvents = parseSseEvents(value);
  const parsed = parseJsonValue(value);
  const eventPayloads = sseEvents?.map(parseJsonValue) ?? [];
  const response = (eventPayloads.at(-1) ?? parsed) as unknown;
  const responseRecord = isRecord(response) ? response : null;
  const content =
    eventPayloads
      .map(getStreamingEventText)
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
          <Snippet
            className="max-h-80 w-full overflow-auto"
            language="text"
            variant="borderless"
          >
            {content}
          </Snippet>
        ) : (
          <div className="text-xs text-secondary">
            No aggregate response content
          </div>
        )}
      </div>
      <RawPayload value={value} />
    </Block>
  );
};

const RawDebugSection = ({
  title,
  value,
}: {
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
      <RawPayload value={value} />
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
    onEnabledChange,
    onLoadDetail,
    onMaxEntriesChange,
    onRefresh,
    onSave,
  } = useDebug();
  const debugText = useTranslations('Admin.debug');
  const [openTraceIds, setOpenTraceIds] = useState<string[]>([]);
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
            <Collapse
              activeKey={openTraceIds}
              className="debug-entry w-full min-w-0 max-w-full"
              items={debug.items.map((item) => ({
                children: (
                  <div className="grid gap-4 w-full min-w-0 pt-1">
                    {!debug.detailLoadedIds[item.id] ? (
                      <div className="text-sm text-secondary">
                        Loading trace detail...
                      </div>
                    ) : (
                      <>
                        <RawDebugSection
                          title={debugText('request')}
                          value={item.requestBody}
                        />
                        <StructuredUpstreamRequest
                          title={debugText('upstreamRequest')}
                          value={item.upstreamRequest?.body}
                        />
                        <StructuredUpstreamResponse
                          value={item.upstreamResponse?.body}
                        />
                        <RawDebugSection
                          title={debugText('response')}
                          value={item.transformedResponse?.body}
                        />
                      </>
                    )}
                  </div>
                ),
                key: item.id,
                label: (
                  <div className="grid items-start gap-3 w-full min-w-0 max-w-full text-left">
                    <div className="font-medium text-text-light dark:text-text-dark break-words text-left">
                      {item.route}
                    </div>
                    <div className="flex flex-wrap items-start gap-2 text-xs min-w-0 max-w-full">
                      <Tag
                        className="debug-credential !px-0 min-w-0 max-w-full whitespace-normal"
                        variant="borderless"
                      >
                        {debugText('credential')}:{' '}
                        <span className="break-all">
                          {item.credentialFilename ??
                            debugText('credentialUnknown')}
                        </span>
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
                    <Flexbox
                      align="flex-start"
                      className="debug-entry-tags text-xs text-left"
                      gap={20}
                      horizontal
                      width="100%"
                      wrap="wrap"
                    >
                      <DebugMetric
                        icon={Bot}
                        label="Model"
                        value={item.model}
                      />
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
                          hasDuration(item.elapsedMs) &&
                          item.elapsedMs > 0 &&
                          item.usage?.totalTokens
                            ? Math.round(
                                (item.usage.totalTokens * 1_000) /
                                  item.elapsedMs,
                              )
                            : null
                        }
                      />
                      <DebugMetric
                        icon={Clock3}
                        label="Request duration"
                        value={
                          hasDuration(item.elapsedMs)
                            ? formatDuration(item.elapsedMs)
                            : null
                        }
                      />
                    </Flexbox>
                  </div>
                ),
              }))}
              onChange={(keys) => {
                const nextOpenTraceIds = Array.isArray(keys) ? keys : [keys];
                setOpenTraceIds(nextOpenTraceIds);
                nextOpenTraceIds.forEach((id) => {
                  if (
                    !debug.detailLoadedIds[id] &&
                    !debug.detailLoadingIds[id]
                  ) {
                    onLoadDetail?.(id);
                  }
                });
              }}
              padding={{ body: 16, header: 16 }}
              variant="outlined"
            />
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
