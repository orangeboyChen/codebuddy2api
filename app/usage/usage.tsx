'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useUsageTab, type UsageRange } from '@/lib/client/console';

const rangeOptions: UsageRange[] = [
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
  'today',
  'yesterday',
];

const Usage = () => {
  const {
    onAccessKeyChange,
    onAutoRefreshSecondsChange,
    onClearHistory,
    onCredentialChange,
    onRangeChange,
    onRefresh,
    usage,
  } = useUsageTab();
  const translations = useTranslations('Admin');

  return (
    <Flexbox direction="vertical" gap={24} id="usage">
      <Block direction="vertical" gap={8} padding={24} variant="outlined">
        <div className="text-sm text-text-description-light dark:text-text-description-dark">
          {translations('sections.usage.eyebrow')}
        </div>
        <div className="text-lg font-semibold">
          {translations('sections.usage.title')}
        </div>
      </Block>
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <div className="grid gap-4 md:grid-cols-4">
          <select
            aria-label={translations('sections.usage.title')}
            onChange={(event) =>
              onRangeChange(event.target.value as UsageRange)
            }
            value={usage.request.range}
          >
            {rangeOptions.map((range) => (
              <option key={range} value={range}>
                {range}
              </option>
            ))}
          </select>
          <select
            aria-label={translations('tabs.credentials')}
            onChange={(event) => onCredentialChange(event.target.value)}
            value={usage.request.credential}
          >
            {usage.filters.credentials.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label={translations('tabs.credentials')}
            onChange={(event) => onAccessKeyChange(event.target.value)}
            value={usage.request.accessKey}
          >
            {usage.filters.accessKeys.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {usage.autoRefreshVisible ? (
            <select
              aria-label={translations('common.refresh')}
              onChange={(event) =>
                onAutoRefreshSecondsChange(Number(event.target.value))
              }
              value={usage.autoRefreshSeconds}
            >
              {[0, 5, 10, 15, 30, 60, 120, 300].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <Flexbox gap={8} horizontal>
          <button disabled={usage.loading} onClick={onRefresh} type="button">
            <RefreshCw aria-hidden="true" size={16} />
            {translations('common.refresh')}
          </button>
          <button
            disabled={usage.loading}
            onClick={onClearHistory}
            type="button"
          >
            <Trash2 aria-hidden="true" size={16} />
            {translations('common.cancel')}
          </button>
        </Flexbox>
      </Block>
      <div className="grid gap-6 md:grid-cols-3">
        {[
          usage.todaySummary.callCount,
          usage.todaySummary.totalTokens,
          usage.todaySummary.cacheHitTokens,
        ].map((value, index) => (
          <Block
            key={index}
            direction="vertical"
            gap={8}
            padding={24}
            variant="outlined"
          >
            <div className="text-3xl font-bold">{value.toLocaleString()}</div>
          </Block>
        ))}
      </div>
      <Block direction="vertical" gap={12} padding={24} variant="outlined">
        {usage.tableRows.map((row) => (
          <Flexbox
            key={row.model}
            className="border-b border-border-light p-3 dark:border-border-dark"
            distribution="space-between"
            horizontal
          >
            <span>{row.model}</span>
            <span>{row.callCount.toLocaleString()}</span>
            <span>{row.totalTokens.toLocaleString()}</span>
            <span>{row.cacheHitTokens.toLocaleString()}</span>
          </Flexbox>
        ))}
      </Block>
    </Flexbox>
  );
};

export default Usage;
