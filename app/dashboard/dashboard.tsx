'use client';

import { ActionIcon, Block, Flexbox, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import {
  BarChart3,
  ChartNoAxesCombined,
  Check,
  Clock3,
  Copy,
  KeyRound,
  Link,
  RefreshCw,
  Server,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';
import { atom } from 'jotai';

import type { AdminConsoleInitialData } from '@/app/page-data';

export interface DashboardState {
  apiEndpoint: string;
  credentialUsage: Array<[string, number]>;
  credentialUsagePercent: number;
  lastCheckedAt: string;
  loading: boolean;
  modelUsage: Array<[string, number]>;
  serviceStatus: 'online' | 'offline' | 'warning';
  statusText: string;
  totalApiCalls: number;
  totalCredentials: number;
  uptimeText: string;
  validCredentials: number;
}

export const defaultDashboardState: DashboardState = {
  apiEndpoint: '',
  credentialUsage: [],
  credentialUsagePercent: 0,
  lastCheckedAt: '',
  loading: true,
  modelUsage: [],
  serviceStatus: 'warning',
  statusText: '',
  totalApiCalls: 0,
  totalCredentials: 0,
  uptimeText: '',
  validCredentials: 0,
};

export const dashboardStateAtom = atom<DashboardState>(defaultDashboardState);

export const createDashboardState = (
  initialData: AdminConsoleInitialData,
): DashboardState => {
  const validCredentials = initialData.credentials.filter(
    (item) => !item.is_expired,
  ).length;
  const totalApiCalls = Object.values(initialData.stats.model_usage).reduce(
    (total, count) => total + count,
    0,
  );
  const credentialUsagePercent = initialData.credentials.length
    ? (validCredentials / initialData.credentials.length) * 100
    : 0;

  return {
    apiEndpoint: initialData.apiEndpoint,
    credentialUsage: Object.entries(initialData.stats.credential_usage).sort(
      (left, right) => right[1] - left[1],
    ),
    credentialUsagePercent,
    lastCheckedAt: initialData.health.checkedAtLabel,
    loading: false,
    modelUsage: Object.entries(initialData.stats.model_usage).sort(
      (left, right) => right[1] - left[1],
    ),
    serviceStatus:
      initialData.health.status === 'healthy' ? 'online' : 'offline',
    statusText: initialData.health.status === 'healthy' ? 'online' : 'offline',
    totalApiCalls,
    totalCredentials: initialData.credentials.length,
    uptimeText:
      initialData.health.uptimeText ||
      initialData.health.checkedAtLabel ||
      initialData.health.timestamp,
    validCredentials,
  };
};

export interface DashboardController {
  dashboard: DashboardState;
  onCopyEndpoint: () => void;
  onRefresh: () => void;
}

const DashboardContext = createContext<DashboardController | null>(null);
export const DashboardProvider = DashboardContext.Provider;

const useDashboard = (): DashboardController => {
  const controller = useContext(DashboardContext);
  if (!controller) throw new Error('Dashboard controller is unavailable');
  return controller;
};

const ringStyle = (percent: number): { strokeDasharray: string } => {
  const circumference = 2 * Math.PI * 20;
  const clampedPercent = Math.min(100, Math.max(0, percent));

  return {
    strokeDasharray: `${(clampedPercent / 100) * circumference} ${circumference}`,
  };
};

const SectionTitle = ({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) => {
  return (
    <Flexbox align="center" gap={8} horizontal>
      <Icon aria-hidden="true" size={18} strokeWidth={2} />
      <h3 className="section-title">{title}</h3>
    </Flexbox>
  );
};

const Dashboard = () => {
  const { dashboard, onCopyEndpoint, onRefresh } = useDashboard();
  const translations = useTranslations('Admin');
  const statusText =
    dashboard.serviceStatus === 'online'
      ? translations('dashboard.statusRunning')
      : dashboard.serviceStatus === 'offline'
        ? translations('dashboard.statusUnavailable')
        : dashboard.statusText;
  const checkedAt =
    dashboard.lastCheckedAt ||
    dashboard.uptimeText ||
    translations('dashboard.refreshPending');

  return (
    <Flexbox direction="vertical" gap={24} id="dashboard">
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
              {translations('dashboard.credentials')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="whitespace-nowrap text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="totalCredentials"
            >
              {dashboard.totalCredentials}
            </div>
            <div
              className="relative h-14 w-14 shrink-0"
              id="credentialUsageRing"
            >
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
                  id="credentialRingProgress"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={ringStyle(dashboard.credentialUsagePercent)}
                />
              </svg>
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-text-light dark:text-text-dark"
                id="credentialUsagePercent"
              >
                {Math.round(dashboard.credentialUsagePercent)}%
              </div>
            </div>
          </Flexbox>
          <Flexbox align="center" gap={4} horizontal id="credentialTrend">
            <Check aria-hidden="true" size={14} strokeWidth={2} />
            <span id="validCredentials">
              {translations('dashboard.active', {
                count: dashboard.validCredentials,
              })}
            </span>
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
            <Server
              aria-hidden="true"
              id="serviceStatusIcon"
              size={18}
              strokeWidth={2}
            />
            <div className="dashboard-metric-label">
              {translations('dashboard.serviceStatus')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="statusText"
            >
              {statusText}
            </div>
            <Tag
              color={
                dashboard.serviceStatus === 'online'
                  ? 'success'
                  : dashboard.serviceStatus === 'offline'
                    ? 'error'
                    : 'warning'
              }
              id="serviceStatus"
              variant="borderless"
            >
              <span id="statusDot" />
            </Tag>
          </Flexbox>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
            id="uptimeTrend"
          >
            <Clock3 aria-hidden="true" size={14} strokeWidth={2} />
            <span aria-live="polite" id="uptime">
              {checkedAt}
            </span>
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
            <Link aria-hidden="true" size={18} strokeWidth={2} />
            <div className="dashboard-metric-label">
              {translations('dashboard.apiEndpointTitle')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-lg font-bold text-text-light dark:text-text-dark leading-none break-all"
              id="apiEndpoint"
            >
              {dashboard.apiEndpoint || '-'}
            </div>
            <ActionIcon
              aria-label={translations('dashboard.copyLink')}
              icon={Copy}
              onClick={onCopyEndpoint}
              title={translations('dashboard.copyLink')}
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
              {translations('dashboard.apiCalls')}
            </div>
          </Flexbox>
          <Flexbox align="center" distribution="space-between" horizontal>
            <div
              className="text-2xl font-bold text-text-light dark:text-text-dark leading-none"
              id="totalApiCalls"
            >
              {dashboard.totalApiCalls}
            </div>
            <div className="relative h-14 w-14 shrink-0" id="totalUsageRing">
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
                  id="usageRingProgress"
                  // eslint-disable-next-line react/forbid-dom-props
                  style={ringStyle(dashboard.totalApiCalls > 0 ? 100 : 0)}
                />
              </svg>
              <div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-semibold text-text-light dark:text-text-dark"
                id="totalUsagePercent"
              >
                {dashboard.totalApiCalls}
              </div>
            </div>
          </Flexbox>
          <Flexbox
            align="center"
            className="dashboard-metric-footer"
            gap={4}
            horizontal
            id="apiCallsTrend"
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
          <SectionTitle
            icon={BarChart3}
            title={translations('dashboard.modelUsage')}
          />
          <Button
            className="dashboard-refresh"
            icon={RefreshCw}
            onClick={onRefresh}
            type="primary"
          >
            {translations('common.refresh')}
          </Button>
        </Flexbox>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('dashboard.modelName')}
                </th>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark text-right">
                  {translations('dashboard.usageTableCalls')}
                </th>
              </tr>
            </thead>
            <tbody id="modelUsageTableBody">
              {dashboard.modelUsage.length ? (
                dashboard.modelUsage.map(([model, count]) => (
                  <tr key={model}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {model}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {count}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                    colSpan={2}
                  >
                    {translations('dashboard.noModelUsage')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
      <Block
        className="dashboard-data-block"
        direction="vertical"
        gap={16}
        padding={24}
        variant="outlined"
      >
        <SectionTitle
          icon={KeyRound}
          title={translations('dashboard.credentialUsage')}
        />
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse mt-4">
            <thead>
              <tr>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark">
                  {translations('dashboard.usageCredential')}
                </th>
                <th className="p-3 px-4 text-left font-semibold border-b border-border-light dark:border-border-dark text-right">
                  {translations('dashboard.usageTableCalls')}
                </th>
              </tr>
            </thead>
            <tbody id="credentialUsageTableBody">
              {dashboard.credentialUsage.length ? (
                dashboard.credentialUsage.map(([filename, count]) => (
                  <tr key={filename}>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark">
                      {filename}
                    </td>
                    <td className="p-3 px-4 border-b border-border-light dark:border-border-dark text-right">
                      {count}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    className="p-3 px-4 border-b border-border-light dark:border-border-dark text-center"
                    colSpan={2}
                  >
                    {translations('dashboard.noCredentialUsage')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>
    </Flexbox>
  );
};

export default Dashboard;
