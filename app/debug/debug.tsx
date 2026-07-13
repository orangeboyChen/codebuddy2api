'use client';

import { Block, Flexbox, Input, Tag } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import {
  Copy,
  Info,
  LoaderCircle,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import { atom } from 'jotai';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

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
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
  } | null;
  upstreamResponse: {
    body: unknown;
    headers: Record<string, string>;
    status: number;
  } | null;
}

export interface DebugState {
  autoRefreshSeconds: number;
  enabled: boolean;
  items: DebugLogEntry[];
  loading: boolean;
  maxEntries: number;
  saving: boolean;
}

export interface AdminDebugSnapshot {
  autoRefreshSeconds: number;
  enabled: boolean;
  items: DebugLogEntry[];
  maxEntries: number;
}

export const defaultDebugState: DebugState = {
  autoRefreshSeconds: 0,
  enabled: false,
  items: [],
  loading: true,
  maxEntries: 100,
  saving: false,
};

export const debugStateAtom = atom<DebugState>(defaultDebugState);

export const createDebugState = (initialData: {
  debug: AdminDebugSnapshot;
}): DebugState => {
  return {
    autoRefreshSeconds: initialData.debug.autoRefreshSeconds,
    enabled: initialData.debug.enabled,
    items: initialData.debug.items,
    loading: false,
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
    onMaxEntriesChange,
    onRefresh,
    onSave,
  } = useDebug();
  const debugText = useTranslations('Admin.debug');

  const renderDebugBlock = (title: string, value: unknown) => {
    const content = JSON.stringify(value ?? null, null, 2);
    const singleLinePreview = content.replace(/\s+/g, ' ').trim() || 'null';
    const sseEvents = parseSseEvents(value);

    return (
      <Block
        as="details"
        className="debug-payload w-full min-w-0 max-w-full"
        padding={12}
        variant="outlined"
      >
        <summary className="debug-payload-summary list-none cursor-pointer p-3 flex items-start justify-between gap-3 w-full min-w-0 max-w-full">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-light dark:text-text-dark mb-1">
              {title}
            </div>
            <div className="block w-full min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-secondary">
              {singleLinePreview}
            </div>
          </div>
          <Button
            icon={Copy}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopy(content);
            }}
            size="small"
          >
            {debugText('copy')}
          </Button>
        </summary>
        {sseEvents ? (
          <div className="w-full min-w-0 max-w-full overflow-x-auto p-3 pt-0">
            <table className="w-full min-w-[480px] border-collapse text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                    {debugText('eventIndex')}
                  </th>
                  <th className="p-3 text-left font-semibold border-b border-border-light dark:border-border-dark">
                    {debugText('eventData')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sseEvents.map((event, index) => {
                  let eventContent = event;
                  try {
                    eventContent = JSON.stringify(JSON.parse(event), null, 2);
                  } catch {
                    eventContent = event;
                  }
                  return (
                    <tr key={`${title}-${index}`}>
                      <td className="p-3 align-top border-b border-border-light dark:border-border-dark text-secondary">
                        {index + 1}
                      </td>
                      <td className="p-3 border-b border-border-light dark:border-border-dark">
                        <pre className="whitespace-pre-wrap break-all text-text-light dark:text-text-dark">
                          {eventContent}
                        </pre>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="w-full min-w-0 max-w-full overflow-hidden p-3 pt-0 whitespace-pre-wrap break-all text-xs text-text-light dark:text-text-dark">
            {content}
          </pre>
        )}
      </Block>
    );
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
        {debug.loading ? (
          <div className="text-center py-8 text-secondary">
            <LoaderCircle />
            <div>{debugText('loading')}</div>
          </div>
        ) : debug.items.length ? (
          <div className="grid gap-4 w-full min-w-0">
            {debug.items.map((item) => (
              <Block
                as="details"
                key={item.id}
                className="debug-entry w-full min-w-0 max-w-full"
                padding={16}
                variant="outlined"
              >
                <summary className="debug-entry-summary cursor-pointer list-none p-4 flex flex-wrap items-center justify-between gap-3 w-full min-w-0 max-w-full overflow-hidden">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-text-light dark:text-text-dark">
                      {item.route}
                    </div>
                    <div className="text-sm text-secondary break-all min-w-0 max-w-full">
                      {item.createdAt} · key:{' '}
                      {item.requestKey ?? debugText('requestKeyNone')}
                    </div>
                  </div>
                  <div className="debug-entry-tags flex flex-wrap gap-2 text-xs min-w-0 max-w-full">
                    <Tag variant="borderless">
                      {debugText('upstreamStatus', {
                        value: item.upstreamResponse?.status ?? '-',
                      })}
                    </Tag>
                    <Tag variant="borderless">
                      {debugText('returnedStatus', {
                        value: item.transformedResponse?.status ?? '-',
                      })}
                    </Tag>
                    <Tag variant="borderless">
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
                </summary>
                <div className="debug-entry-content p-4 pt-0 grid gap-4 w-full min-w-0">
                  {renderDebugBlock(debugText('request'), item.requestBody)}
                  {renderDebugBlock(
                    debugText('upstreamRequest'),
                    item.upstreamRequest?.body,
                  )}
                  {renderDebugBlock(
                    debugText('upstreamResponse'),
                    item.upstreamResponse?.body,
                  )}
                  {renderDebugBlock(
                    debugText('response'),
                    item.transformedResponse?.body,
                  )}
                </div>
              </Block>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-secondary">
            {debugText('empty')}
          </div>
        )}
      </Block>
    </div>
  );
};

export default Debug;
