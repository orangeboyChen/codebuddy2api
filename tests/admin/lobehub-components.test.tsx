// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import Dashboard from '@/app/dashboard/dashboard';
import { DashboardProvider } from '@/app/dashboard/dashboard';
import Debug, { DebugProvider } from '@/app/debug/debug';
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

describe('debug view', () => {
  it('aggregates OpenAI streaming choice deltas', async () => {
    renderWithMessages(
      <DebugProvider
        value={{
          autoRefreshOptions: [],
          debug: {
            autoRefreshSeconds: 0,
            detailLoadedIds: { stream: true },
            detailLoadingIds: {},
            enabled: true,
            items: [
              {
                credentialFilename: null,
                createdAt: '2026-07-18T00:00:00.000Z',
                elapsedMs: null,
                error: null,
                id: 'stream',
                requestBody: {},
                requestKey: null,
                route: '/v1/chat/completions',
                transformedResponse: null,
                upstreamRequest: {
                  body: {
                    messages: [
                      { content: 'What is 2 + 2?', role: 'user' },
                      { content: '2 + 2 equals 4.', role: 'assistant' },
                    ],
                    model: 'hy3',
                  },
                  method: 'POST',
                  url: 'https://upstream.test',
                },
                upstreamResponse: {
                  body: 'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n',
                  status: 200,
                },
              },
            ],
            loading: false,
            maxEntries: 100,
            saving: false,
          },
          onAutoRefreshSecondsChange: vi.fn(),
          onClear: vi.fn(),
          onCopy: vi.fn(),
          onEnabledChange: vi.fn(),
          onMaxEntriesChange: vi.fn(),
          onRefresh: vi.fn(),
          onSave: vi.fn(),
        }}
      >
        <Debug />
      </DebugProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /\/v1\/chat\/completions/ }),
    );

    await waitFor(() => {
      expect(document.body).toHaveTextContent('Hello world');
    });
    expect(screen.queryByText('nullms')).not.toBeInTheDocument();
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(screen.queryByText('User')).not.toBeInTheDocument();
  });

  it('aggregates Responses API streaming deltas', async () => {
    renderWithMessages(
      <DebugProvider
        value={{
          autoRefreshOptions: [],
          debug: {
            autoRefreshSeconds: 0,
            detailLoadedIds: { responses: true },
            detailLoadingIds: {},
            enabled: true,
            items: [
              {
                credentialFilename: null,
                createdAt: '2026-07-18T00:00:00.000Z',
                elapsedMs: null,
                error: null,
                id: 'responses',
                requestBody: {},
                requestKey: null,
                route: '/v1/responses',
                transformedResponse: null,
                upstreamRequest: null,
                upstreamResponse: {
                  body: 'data: {"type":"response.output_text.delta","delta":"Hello "}\n\ndata: {"type":"response.output_text.delta","delta":"world"}\n\ndata: [DONE]\n\n',
                  status: 200,
                },
              },
            ],
            loading: false,
            maxEntries: 100,
            saving: false,
          },
          onAutoRefreshSecondsChange: vi.fn(),
          onClear: vi.fn(),
          onCopy: vi.fn(),
          onEnabledChange: vi.fn(),
          onMaxEntriesChange: vi.fn(),
          onRefresh: vi.fn(),
          onSave: vi.fn(),
        }}
      >
        <Debug />
      </DebugProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /\/v1\/responses/ }));

    await waitFor(() => {
      expect(document.body).toHaveTextContent('Hello world');
    });
  });
});
