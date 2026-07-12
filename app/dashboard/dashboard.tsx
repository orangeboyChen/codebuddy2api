'use client';

import { ActionIcon, Block, Flexbox } from '@lobehub/ui';
import {
  ChartNoAxesCombined,
  Check,
  Clock3,
  Copy,
  KeyRound,
  RefreshCw,
  Server,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useDashboardTab } from '@/lib/client/console';

const ringStyle = (percent: number): { strokeDasharray: string } => {
  const circumference = 2 * Math.PI * 20;
  const clampedPercent = Math.min(100, Math.max(0, percent));

  return {
    strokeDasharray: `${(clampedPercent / 100) * circumference} ${circumference}`,
  };
};

const Dashboard = () => {
  const { dashboard, onCopyEndpoint, onRefresh } = useDashboardTab();
  const translations = useTranslations('Admin');
  const statusText =
    dashboard.serviceStatus === 'online'
      ? translations('console.serviceRunning')
      : dashboard.serviceStatus === 'offline'
        ? translations('console.serviceUnavailable')
        : dashboard.statusText;
  const checkedAt = dashboard.lastCheckedAt || dashboard.uptimeText;

  return (
    <Flexbox direction="vertical" gap={24} id="dashboard">
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={8}
        padding={24}
        variant="outlined"
      >
        <div className="text-sm text-text-description-light dark:text-text-description-dark">
          {translations('sections.dashboard.eyebrow')}
        </div>
        <div className="text-lg font-semibold">
          {translations('sections.dashboard.title')}
        </div>
      </Block>
      <div className="dashboard-metric-grid">
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <KeyRound aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {translations('tabs.credentials')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div className="text-2xl font-bold">
              {dashboard.totalCredentials}
            </div>
            <div className="relative h-14 w-14 shrink-0">
              <svg height="56" width="56">
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  className="fill-none stroke-border-light dark:stroke-border-dark stroke-4"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="20"
                  className="fill-none stroke-primary stroke-4 transition-all"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={ringStyle(dashboard.credentialUsagePercent)}
                />
              </svg>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-semibold">
                {Math.round(dashboard.credentialUsagePercent)}%
              </div>
            </div>
          </Flexbox>
          <Flexbox align="center" gap={4} horizontal>
            <Check aria-hidden="true" size={14} strokeWidth={2} />
            <span>{dashboard.validCredentials}</span>
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <Server aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {translations('sections.dashboard.eyebrow')}
            </div>
          </Flexbox>
          <div className="text-2xl font-bold">{statusText}</div>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
          >
            <Clock3 aria-hidden="true" size={14} strokeWidth={2} />
            <span>{checkedAt}</span>
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <Copy aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {translations('console.copyEndpoint')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div className="break-all text-lg font-bold">
              {dashboard.apiEndpoint || '-'}
            </div>
            <ActionIcon
              aria-label={translations('common.copy')}
              icon={Copy}
              onClick={onCopyEndpoint}
            />
          </Flexbox>
        </Block>
        <Block
          className="dashboard-metric-card"
          direction="vertical"
          gap={12}
          padding={24}
          variant="outlined"
        >
          <Flexbox
            align="center"
            className="dashboard-metric-header"
            gap={8}
            horizontal
          >
            <ChartNoAxesCombined aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {translations('tabs.usage')}
            </div>
          </Flexbox>
          <div className="text-2xl font-bold">{dashboard.totalApiCalls}</div>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
          >
            <Clock3 aria-hidden="true" size={14} strokeWidth={2} />
            <span>{checkedAt}</span>
          </Flexbox>
        </Block>
      </div>
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <Flexbox align="center" distribution="space-between" horizontal>
          <div className="text-base font-semibold">
            {translations('tabs.usage')}
          </div>
          <button
            className="dashboard-refresh"
            onClick={onRefresh}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
            {translations('common.refresh')}
          </button>
        </Flexbox>
        <div className="w-full overflow-x-auto">
          {dashboard.modelUsage.map(([model, count]) => (
            <Flexbox
              key={model}
              className="border-b border-border-light p-3 dark:border-border-dark"
              distribution="space-between"
              horizontal
            >
              <span>{model}</span>
              <span>{count}</span>
            </Flexbox>
          ))}
        </div>
      </Block>
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <div className="text-base font-semibold">
          {translations('tabs.credentials')}
        </div>
        <div className="w-full overflow-x-auto">
          {dashboard.credentialUsage.map(([filename, count]) => (
            <Flexbox
              key={filename}
              className="border-b border-border-light p-3 dark:border-border-dark"
              distribution="space-between"
              horizontal
            >
              <span>{filename}</span>
              <span>{count}</span>
            </Flexbox>
          ))}
        </div>
      </Block>
    </Flexbox>
  );
};

export default Dashboard;
