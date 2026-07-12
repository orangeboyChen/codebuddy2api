// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  DashboardSection,
  TabNav,
} from '@/app/admin/_components/admin-sections';
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

describe('LobeHub admin components', () => {
  it('keeps the horizontal tab labels and selection callback intact', () => {
    const onChange = vi.fn();

    renderWithMessages(<TabNav activeTab="dashboard" onChange={onChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));

    expect(onChange).toHaveBeenCalledWith('usage');
    expect(screen.getByRole('tab', { name: 'Dashboard' })).toBeVisible();
  });

  it('keeps all four dashboard cards visible', () => {
    renderWithMessages(
      <>
        <DashboardSection
          onCopyEndpoint={vi.fn()}
          onRefresh={vi.fn()}
          state={{
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
          }}
        />
      </>,
    );

    expect(document.getElementById('totalCredentials')).toHaveTextContent('2');
    expect(document.getElementById('apiEndpoint')).toHaveTextContent(
      'http://localhost:8001/v1',
    );
    expect(document.getElementById('totalApiCalls')).toHaveTextContent('42');
    expect(
      document.querySelector('#dashboard > div:first-child')?.children,
    ).toHaveLength(4);
  });

  it('keeps the initial service status time visible', () => {
    renderWithMessages(
      <DashboardSection
        onCopyEndpoint={vi.fn()}
        onRefresh={vi.fn()}
        state={{
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
        }}
      />,
    );

    expect(document.getElementById('uptime')).toHaveTextContent(
      'Last checked 7/12/2026, 5:00:00 PM',
    );
  });
});
