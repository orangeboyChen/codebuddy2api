'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { Copy, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useDebugTab } from '@/lib/client/console';

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
  } = useDebugTab();
  const translations = useTranslations('Admin');

  return (
    <Flexbox direction="vertical" gap={24} id="debug">
      <Block direction="vertical" gap={8} padding={24} variant="outlined">
        <div className="text-sm text-text-description-light dark:text-text-description-dark">
          {translations('sections.debug.eyebrow')}
        </div>
        <div className="text-lg font-semibold">
          {translations('sections.debug.title')}
        </div>
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox distribution="space-between" horizontal>
          <label>
            <input
              checked={debug.enabled}
              disabled={debug.saving}
              onChange={(event) => onEnabledChange(event.target.checked)}
              type="checkbox"
            />
            {translations('tabs.debug')}
          </label>
          <select
            aria-label={translations('common.refresh')}
            disabled={!debug.enabled || debug.saving}
            onChange={(event) =>
              onAutoRefreshSecondsChange(Number(event.target.value))
            }
            value={debug.autoRefreshSeconds}
          >
            {autoRefreshOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            aria-label={translations('tabs.debug')}
            disabled={debug.saving}
            min={1}
            onChange={(event) =>
              onMaxEntriesChange(Number(event.target.value) || 1)
            }
            type="number"
            value={debug.maxEntries}
          />
        </Flexbox>
        <Flexbox gap={8} horizontal>
          <button disabled={debug.saving} onClick={onSave} type="button">
            <Save aria-hidden="true" size={16} />
            {translations('common.save')}
          </button>
          <button disabled={debug.loading} onClick={onRefresh} type="button">
            <RefreshCw aria-hidden="true" size={16} />
            {translations('common.refresh')}
          </button>
          <button disabled={debug.saving} onClick={onClear} type="button">
            <Trash2 aria-hidden="true" size={16} />
            {translations('common.cancel')}
          </button>
        </Flexbox>
      </Block>
      {debug.items.map((item) => {
        const content = JSON.stringify(item, null, 2);

        return (
          <Block
            as="details"
            key={item.id}
            direction="vertical"
            gap={12}
            padding={16}
            variant="outlined"
          >
            <summary className="cursor-pointer">{item.route}</summary>
            <Flexbox distribution="space-between" horizontal>
              <span>{item.createdAt}</span>
              <button
                aria-label={translations('common.copy')}
                onClick={() => onCopy(content)}
                type="button"
              >
                <Copy aria-hidden="true" size={16} />
              </button>
            </Flexbox>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">
              {content}
            </pre>
          </Block>
        );
      })}
    </Flexbox>
  );
};

export default Debug;
