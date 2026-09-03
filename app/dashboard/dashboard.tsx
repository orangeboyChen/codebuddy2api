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
import { useLocale, useMessages, useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

import type { AdminConsoleInitialData } from '@/app/page-data';
import type { AppMessages } from '@/lib/i18n/messages';
import packageJson from '@/package.json';

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

export const getDailyMessage = (messages: unknown): string => {
  const availableMessages =
    messages && typeof messages === 'object' && !Array.isArray(messages)
      ? Object.values(messages).filter(
          (message): message is string => typeof message === 'string',
        )
      : [];
  if (!availableMessages.length) return '';

  const today = new Date();
  const dayIndex =
    (today.getFullYear() * 372 + today.getMonth() * 31 + today.getDate()) %
    availableMessages.length;

  return availableMessages[dayIndex];
};

const Dashboard = () => {
  const { dashboard } = useDashboard();
  const locale = useLocale();
  const messages = useMessages() as unknown as AppMessages;
  const translations = useTranslations('Admin.dashboard');
  const usageTranslations = useTranslations('Admin.usage');
  const dailyMessage = getDailyMessage(messages.Admin.dashboard.messages.daily);
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
      <div className="dashboard-github-link">
        <a
          aria-label="orangeboyChen/codebuddy2api on GitHub"
          className="dashboard-github-repository"
          href="https://github.com/orangeboyChen/codebuddy2api"
          rel="noreferrer"
          target="_blank"
        >
          <svg
            aria-hidden="true"
            className="dashboard-github-icon"
            height="18"
            viewBox="0 0 24 24"
            width="18"
          >
            <path
              d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.009-1.024-.014-1.856-2.782.604-3.369-1.18-3.369-1.18-.455-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.607.069-.607 1.004.07 1.532 1.031 1.532 1.031.892 1.529 2.341 1.087 2.91.832.091-.647.349-1.087.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0 1 12 7.844a9.56 9.56 0 0 1 2.504.337c1.909-1.294 2.748-1.025 2.748-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.337-.012 2.415-.012 2.744 0 .267.18.578.688.48A10.003 10.003 0 0 0 22 12C22 6.477 17.523 2 12 2Z"
              fill="currentColor"
            />
          </svg>
          <span>orangeboyChen/codebuddy2api</span>
        </a>
        <span className="dashboard-version">v{packageJson.version}</span>
      </div>
    </Flexbox>
  );
};

export default Dashboard;
