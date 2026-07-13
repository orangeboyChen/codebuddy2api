// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import Dashboard from '@/app/dashboard/dashboard';
import { DashboardProvider } from '@/app/dashboard/dashboard';
import { getMessages } from '@/lib/i18n/messages';

const renderWithMessages = (children: React.ReactNode) => {
  return render(
    <ConfigProvider motion={motion}>
      <NextIntlClientProvider locale="en-US" messages={getMessages('en-US')}>
        {children}
      </NextIntlClientProvider>
    </ConfigProvider>,
  );
};

describe('dashboard view', () => {
  it('keeps all four dashboard cards visible', () => {
    renderWithMessages(
      <DashboardProvider
        value={{
          dashboard: {
            apiEndpoint: 'http://localhost:8001/v1',
            credentialUsage: [],
            credentialUsagePercent: 100,
            lastCheckedAt: 'just now',
            loading: false,
            modelUsage: [],
            serviceStatus: 'online',
            statusText: 'Running',
            totalApiCalls: 42,
            totalCredentials: 2,
            uptimeText: 'ok',
            validCredentials: 2,
          },
          onCopyEndpoint: vi.fn(),
          onRefresh: vi.fn(),
        }}
      >
        <Dashboard />
      </DashboardProvider>,
    );

    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
    expect(screen.getByText('http://localhost:8001/v1')).toBeVisible();
    expect(document.getElementById('totalApiCalls')).toHaveTextContent('42');
    expect(document.querySelectorAll('.dashboard-metric-card')).toHaveLength(4);
  });

  it('keeps the initial service status time visible', () => {
    renderWithMessages(
      <DashboardProvider
        value={{
          dashboard: {
            apiEndpoint: 'http://localhost:8001/v1',
            credentialUsage: [],
            credentialUsagePercent: 0,
            lastCheckedAt: 'Last checked 7/12/2026, 5:00:00 PM',
            loading: false,
            modelUsage: [],
            serviceStatus: 'online',
            statusText: 'Running',
            totalApiCalls: 0,
            totalCredentials: 0,
            uptimeText: '',
            validCredentials: 0,
          },
          onCopyEndpoint: vi.fn(),
          onRefresh: vi.fn(),
        }}
      >
        <Dashboard />
      </DashboardProvider>,
    );

    expect(
      screen.getAllByText('Last checked 7/12/2026, 5:00:00 PM').length,
    ).toBeGreaterThan(0);
  });
});
