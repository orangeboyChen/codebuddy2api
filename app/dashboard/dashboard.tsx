'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { atom } from 'jotai';
import {
  ChartNoAxesCombined,
  Coins,
  DatabaseZap,
  KeyRound,
} from 'lucide-react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

import type { AdminConsoleInitialData } from '@/app/page-data';

export interface DashboardSummary {
  cacheHitTokens: number;
  callCount: number;
  totalTokens: number;
}

export interface DashboardState {
  apiEndpoint: string;
  loading: boolean;
  summary: DashboardSummary;
  totalCredentials: number;
  validCredentials: number;
}

export const defaultDashboardState: DashboardState = {
  apiEndpoint: '',
  loading: true,
  summary: { cacheHitTokens: 0, callCount: 0, totalTokens: 0 },
  totalCredentials: 0,
  validCredentials: 0,
};

export const dashboardStateAtom = atom<DashboardState>(defaultDashboardState);

export const createDashboardState = (
  initialData: Extract<AdminConsoleInitialData, { tab: 'dashboard' }>,
): DashboardState => ({
  apiEndpoint: initialData.apiEndpoint,
  loading: false,
  summary: initialData.usage.rangeSummary,
  totalCredentials: initialData.totalCredentials,
  validCredentials: initialData.validCredentials,
});

export interface DashboardController {
  dashboard: DashboardState;
}

const DashboardContext = createContext<DashboardController | null>(null);
export const DashboardProvider = DashboardContext.Provider;

const useDashboard = (): DashboardController => {
  const controller = useContext(DashboardContext);
  if (!controller) throw new Error('Dashboard controller is unavailable');
  return controller;
};

const formatNumber = (locale: string, value: number) =>
  new Intl.NumberFormat(locale).format(value);

const getDailyMessage = (messages: unknown): string => {
  const availableMessages = Array.isArray(messages)
    ? messages.filter(
        (message): message is string => typeof message === 'string',
      )
    : typeof messages === 'string'
      ? messages.split('|').filter(Boolean)
      : [];
  if (!availableMessages.length) return '';

  const today = new Date();
  const dayIndex =
    (today.getFullYear() * 372 + today.getMonth() * 31 + today.getDate()) %
    availableMessages.length;

  const message = availableMessages[dayIndex];

  if (dayIndex % 10 === 0) return message;

  return message
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const Dashboard = () => {
  const { dashboard } = useDashboard();
  const locale = useLocale();
  const translations = useTranslations('Admin.dashboard');
  const usageTranslations = useTranslations('Admin.usage');
  const dailyMessage = getDailyMessage(translations('tokenMessages'));
  const metrics = [
    {
      icon: KeyRound,
      detail: translations('active', { count: dashboard.validCredentials }),
      label: translations('credentials'),
      value: dashboard.totalCredentials,
    },
    {
      icon: ChartNoAxesCombined,
      label: usageTranslations('callsToday'),
      value: dashboard.summary.callCount,
    },
    {
      icon: Coins,
      label: usageTranslations('tokensToday'),
      value: dashboard.summary.totalTokens,
    },
    {
      icon: DatabaseZap,
      label: usageTranslations('cacheHitToday'),
      value: dashboard.summary.cacheHitTokens,
    },
  ];

  return (
    <Flexbox direction="vertical" gap={24} id="dashboard">
      <section className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <h1>{translations('welcomeTitle')}</h1>
          {dailyMessage ? <p>{dailyMessage}</p> : null}
          <div className="dashboard-api-endpoint">
            <span>{translations('apiEndpointTitle')}</span>
            <code>{dashboard.apiEndpoint}</code>
          </div>
        </div>
        <Image
          alt="CodeBuddy"
          className="dashboard-hero-image"
          height={400}
          src="/images/codebuddy-dashboard.png"
          width={400}
        />
      </section>
      <div className="dashboard-metric-grid" aria-busy={dashboard.loading}>
        {metrics.map(({ detail, icon: Icon, label, value }) => (
          <Block
            key={label}
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
              <Icon aria-hidden="true" size={18} strokeWidth={2} />
              <div className="dashboard-metric-label">{label}</div>
            </Flexbox>
            <div className="dashboard-metric-value">
              {formatNumber(locale, value)}
            </div>
            {detail ? (
              <div className="dashboard-metric-detail">{detail}</div>
            ) : null}
          </Block>
        ))}
      </div>
    </Flexbox>
  );
};

export default Dashboard;
