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
  it('shows the welcome hero, API endpoint, and four summary cards', () => {
    renderWithMessages(
      <DashboardProvider
        value={{
          dashboard: {
            apiEndpoint: 'https://api.example.test/v1',
            loading: false,
            summary: {
              cacheHitTokens: 12,
              callCount: 42,
              totalTokens: 128,
            },
            totalCredentials: 3,
            validCredentials: 2,
          },
        }}
      >
        <Dashboard />
      </DashboardProvider>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByAltText('CodeBuddy')).toBeVisible();
    expect(screen.getByText('42')).toBeVisible();
    expect(screen.getByText('128')).toBeVisible();
    expect(screen.getByText('12')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
    expect(screen.getByText('https://api.example.test/v1')).toBeVisible();
    expect(document.querySelectorAll('.dashboard-metric-card')).toHaveLength(4);
    expect(screen.queryByText('Service status')).not.toBeInTheDocument();
  });
});

describe('debug view', () => {
  it('filters traces by interface type, credential, and masked API key', async () => {
    const items = [
      {
        credentialFilename: 'openai.json',
        createdAt: '2026-07-19T00:00:00.000Z',
        elapsedMs: null,
        error: null,
        id: 'chat',
        requestBody: {},
        requestKey: 'sk-chat****1234',
        route: '/v1/chat/completions',
        transformedResponse: null,
        upstreamRequest: null,
        upstreamResponse: null,
      },
      {
        credentialFilename: 'responses.json',
        createdAt: '2026-07-19T00:00:00.000Z',
        elapsedMs: null,
        error: null,
        id: 'responses',
        requestBody: {},
        requestKey: 'sk-response****5678',
        route: '/v1/responses',
        transformedResponse: null,
        upstreamRequest: null,
        upstreamResponse: null,
      },
      {
        credentialFilename: 'anthropic.json',
        createdAt: '2026-07-19T00:00:00.000Z',
        elapsedMs: null,
        error: null,
        id: 'messages',
        requestBody: {},
        requestKey: 'sk-message****9012',
        route: '/v1/messages',
        transformedResponse: null,
        upstreamRequest: null,
        upstreamResponse: null,
      },
    ];
    const controller = {
      autoRefreshOptions: [],
      debug: {
        autoRefreshSeconds: 0,
        detailLoadedIds: {},
        detailLoadingIds: {},
        enabled: true,
        items,
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
    };
    const renderDebug = () =>
      renderWithMessages(
        <DebugProvider value={controller}>
          <Debug />
        </DebugProvider>,
      );
    const selectFilterOption = async (id: string, label: string) => {
      const filter = document.getElementById(id)!;
      fireEvent.click(filter);
      const option = await screen.findByRole('option', { name: label });
      fireEvent.pointerDown(option, {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
      });
      fireEvent.pointerUp(option, {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
      });
      fireEvent.click(option);
    };

    let debugView = renderDebug();
    await selectFilterOption('debugFilterFormat', 'OpenAI Chat');

    await waitFor(() => {
      expect(screen.getByText('/v1/chat/completions')).toBeInTheDocument();
      expect(screen.queryByText('/v1/responses')).not.toBeInTheDocument();
      expect(screen.queryByText('/v1/messages')).not.toBeInTheDocument();
    });

    debugView.unmount();
    debugView = renderDebug();
    await selectFilterOption('debugFilterCredential', 'responses.json');

    await waitFor(() => {
      expect(
        screen.queryByText('/v1/chat/completions'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('/v1/responses')).toBeInTheDocument();
      expect(screen.queryByText('/v1/messages')).not.toBeInTheDocument();
    });

    debugView.unmount();
    renderDebug();
    await selectFilterOption('debugFilterApiKey', 'sk-message****9012');

    await waitFor(() => {
      expect(
        screen.queryByText('/v1/chat/completions'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('/v1/responses')).not.toBeInTheDocument();
      expect(screen.getByText('/v1/messages')).toBeInTheDocument();
    });
  }, 120_000);

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
                    tools: [
                      {
                        function: {
                          description: 'Create a pull request',
                          name: 'mcp__github__create_pr',
                          parameters: { type: 'object' },
                        },
                        type: 'function',
                      },
                    ],
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
    expect(screen.getByText('github')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /github/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }));
    expect(screen.getByText('mcp__github__create_pr')).toBeInTheDocument();
  }, 60_000);

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
  }, 60_000);
});
