// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  DashboardSection,
  TabNav,
} from '@/app/admin/_components/admin-sections';
import { getMessages } from '@/lib/i18n/messages';

const renderWithMessages = (children: React.ReactNode) => {
  return render(
    <NextIntlClientProvider locale="en-US" messages={getMessages('en-US')}>
      {children}
    </NextIntlClientProvider>,
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
});
