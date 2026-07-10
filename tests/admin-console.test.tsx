// @vitest-environment jsdom

import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import AdminConsole from '@/app/admin/_components/admin-console';
import type { AdminConsoleInitialData } from '@/app/admin/_components/admin-initial-state';

const makeJsonResponse = (payload: unknown, status = 200) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

describe('AdminConsole', () => {
  const initialData: AdminConsoleInitialData = {
    accessKeys: [
      {
        createdAt: '2026-07-11T10:00:00.000Z',
        credentialFilenames: ['cred-1.json'],
        id: 'ak-1',
        maskedSecret: 'sk-***',
        name: 'Primary API Key',
        updatedAt: '2026-07-11T10:00:00.000Z',
      },
    ],
    apiEndpoint: 'http://localhost:3000/v1',
    credentials: [
      {
        created_at: 1_752_225_600,
        domain: 'ioa',
        email: 'user@example.com',
        enterprise_id: null,
        expires_at: null,
        expires_in: null,
        filename: 'cred-1.json',
        first_message_role_to_system: false,
        has_refresh_token: true,
        index: 0,
        is_expired: false,
        name: 'User One',
        responses_passthrough: false,
        scope: null,
        session_state: null,
        tenant_id: null,
        time_remaining: null,
        time_remaining_str: 'never',
        token_type: 'Bearer',
        user_id: 'user-1',
      },
    ],
    currentCredential: {
      available_credential_count: 1,
      filename: 'cred-1.json',
      index: 0,
      next_filename: null,
      status: 'round_robin',
      user_id: 'user-1',
    },
    health: {
      checkedAtLabel: '10:00:00',
      status: 'healthy',
      timestamp: '2026-07-11T10:00:00.000Z',
      uptimeText: 'ok',
    },
    settings: {
      labels: {},
      values: {},
    },
    debug: {
      autoRefreshSeconds: 10,
      enabled: true,
      items: [
        {
          createdAt: '2026-07-11T10:00:00.000Z',
          error: null,
          id: 'debug-1',
          requestBody: { model: 'glm-5.1' },
          requestKey: 'cred-1.json',
          route: '/v1/responses',
          transformedResponse: {
            body: { ok: true },
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
          upstreamRequest: {
            body: { model: 'glm-5.1' },
            headers: { authorization: 'Bearer ***' },
            method: 'POST',
            url: 'https://upstream.example/v1/responses',
          },
          upstreamResponse: {
            body: { id: 'resp_1' },
            headers: { 'content-type': 'text/event-stream' },
            status: 202,
          },
        },
      ],
      maxEntries: 50,
    },
    stats: {
      credential_usage: {},
      model_usage: {},
    },
  };

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        addEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
      })),
      writable: true,
    });

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: vi.fn(),
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
      writable: true,
    });

    Object.defineProperty(window, 'open', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    globalThis.fetch = vi.fn(async (input) => {
      if (input === '/health') {
        return makeJsonResponse({ status: 'healthy' });
      }

      if (input === '/admin-api/credentials') {
        return makeJsonResponse({ credentials: initialData.credentials });
      }

      if (input === '/admin-api/credentials/current') {
        return makeJsonResponse(initialData.currentCredential);
      }

      if (input === '/admin-api/access-keys') {
        return makeJsonResponse({ access_keys: initialData.accessKeys });
      }

      if (input === '/admin-api/debug') {
        return makeJsonResponse(initialData.debug);
      }

      if (input === '/admin-api/stats') {
        return makeJsonResponse({
          credential_usage: {},
          model_usage: {},
        });
      }

      if (input === '/codebuddy/auth/start') {
        return makeJsonResponse({
          auth_state: 'state-1',
          verification_uri_complete: 'https://example.com/device',
        });
      }

      if (
        input === '/codebuddy/auth/poll' ||
        (input instanceof Request && input.url.endsWith('/codebuddy/auth/poll'))
      ) {
        return makeJsonResponse({ error: 'authorization_pending' });
      }

      return makeJsonResponse({});
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps delegated clicks working for auth start', async () => {
    render(React.createElement(AdminConsole));

    await waitFor(() => {
      expect(document.getElementById('totalCredentials')?.textContent).toBe(
        '0',
      );
      expect(document.getElementById('validCredentials')?.textContent).toBe(
        '0',
      );
    });

    fireEvent.click(screen.getByText('凭证管理'));
    fireEvent.click(screen.getByText('开始认证'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(([input]) => {
          return input === '/codebuddy/auth/start';
        }),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(
        (document.getElementById('authUrlInput') as HTMLInputElement).value,
      ).toBe('https://example.com/device');
      expect(
        document.getElementById('authUrlSection')?.classList.contains('hidden'),
      ).toBe(false);
    });
  });

  it('supports system theme and keeps test result panel theme-safe', async () => {
    vi.mocked(globalThis.localStorage.getItem).mockImplementation((key) => {
      if (key === 'codebuddy2api-admin-theme') {
        return 'system';
      }

      return null;
    });

    render(React.createElement(AdminConsole));

    const themeSelect = await screen.findByLabelText('Theme mode');

    expect((themeSelect as HTMLSelectElement).value).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    fireEvent.click(screen.getByText('API 测试'));

    const testResult = await screen.findByText('点击"发送测试"查看API响应...');
    const resultPanel = testResult.closest('#testResult');

    expect(resultPanel).not.toBeNull();
    expect(resultPanel?.className).toContain('text-text-light');
    expect(resultPanel?.className).not.toContain('bg-bg-dark text-text-dark');
  });

  it('shows credential editor inline inside the selected credential card', async () => {
    render(React.createElement(AdminConsole, { initialData }));

    fireEvent.click(screen.getByText('凭证管理'));
    await screen.findByText('Primary API Key');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[1]);

    expect(await screen.findByText('编辑凭证配置')).toBeInTheDocument();
    expect(
      screen.getByText('直接转发 Responses 请求至上游'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Bearer Token')).not.toBeInTheDocument();
    expect(screen.queryByText('手动添加凭证')).not.toBeInTheDocument();
  });

  it('renders usage tab filters, summary, charts, and clear action', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (input === '/admin-api/usage?accessKey=all&credential=all&range=24h') {
        return makeJsonResponse({
          callSeries: [
            {
              model: 'glm-5.1',
              points: [
                {
                  callCount: 2,
                  cacheHitTokens: 10,
                  label: '09:00',
                  start: '2026-07-11T09:00:00.000Z',
                  totalTokens: 120,
                },
                {
                  callCount: 3,
                  cacheHitTokens: 12,
                  label: '10:00',
                  start: '2026-07-11T10:00:00.000Z',
                  totalTokens: 180,
                },
              ],
            },
          ],
          filters: {
            accessKeys: [
              { label: '全部 API Key', value: 'all' },
              { label: 'Primary API Key', value: 'ak-1' },
            ],
            credentials: [
              { label: '全部凭据', value: 'all' },
              { label: 'cred-1.json', value: 'cred-1.json' },
            ],
          },
          range: '24h',
          tableRows: [
            {
              callCount: 5,
              cacheHitTokens: 22,
              model: 'glm-5.1',
              totalTokens: 300,
            },
          ],
          todaySummary: {
            cacheHitTokens: 22,
            callCount: 5,
            totalTokens: 300,
          },
          tokenSeries: [
            {
              model: 'glm-5.1',
              points: [
                {
                  callCount: 2,
                  cacheHitTokens: 10,
                  label: '09:00',
                  start: '2026-07-11T09:00:00.000Z',
                  totalTokens: 120,
                },
                {
                  callCount: 3,
                  cacheHitTokens: 12,
                  label: '10:00',
                  start: '2026-07-11T10:00:00.000Z',
                  totalTokens: 180,
                },
              ],
            },
          ],
        });
      }

      if (
        input === '/admin-api/usage/clear' &&
        init &&
        typeof init === 'object' &&
        'method' in init &&
        init.method === 'POST'
      ) {
        return makeJsonResponse({ success: true });
      }

      if (input === '/health') {
        return makeJsonResponse({ status: 'healthy' });
      }

      if (input === '/admin-api/credentials') {
        return makeJsonResponse({ credentials: initialData.credentials });
      }

      if (input === '/admin-api/credentials/current') {
        return makeJsonResponse(initialData.currentCredential);
      }

      if (input === '/admin-api/access-keys') {
        return makeJsonResponse({ access_keys: initialData.accessKeys });
      }

      if (input === '/admin-api/debug') {
        return makeJsonResponse(initialData.debug);
      }

      if (input === '/admin-api/stats') {
        return makeJsonResponse({
          credential_usage: {},
          model_usage: {},
        });
      }

      return makeJsonResponse({});
    });

    render(React.createElement(AdminConsole));

    fireEvent.click(screen.getByText('用量统计'));

    expect(
      await screen.findByLabelText('用量统计时间范围'),
    ).toBeInTheDocument();
    expect(screen.getByText('今日调用次数')).toBeInTheDocument();
    expect(screen.getByText('Token 消耗趋势')).toBeInTheDocument();
    expect(screen.getByText('模型汇总')).toBeInTheDocument();
    expect(screen.getAllByText('glm-5.1')).toHaveLength(3);
    expect(screen.getByLabelText('用量统计自动刷新间隔')).toHaveValue('15');
    expect(screen.getByRole('option', { name: '关闭' })).toHaveValue('0');
    expect(screen.queryByText('关闭提示')).not.toBeInTheDocument();
    expect(screen.queryByText('悬停节点可查看明细')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('清空历史'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/admin-api/usage/clear',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });

  it('shows API Key reveal and editor inline inside the same card', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, _init) => {
      if (input === '/admin-api/access-keys/ak-1/secret') {
        return makeJsonResponse({
          id: 'ak-1',
          name: 'Primary API Key',
          secret: 'sk-live-123',
        });
      }

      if (
        input === '/admin-api/access-keys/ak-1' &&
        _init?.method === 'PATCH'
      ) {
        return makeJsonResponse({
          access_key: {
            id: 'ak-1',
            name: 'Primary API Key',
          },
        });
      }

      if (input === '/health') {
        return makeJsonResponse({ status: 'healthy' });
      }

      if (input === '/admin-api/credentials') {
        return makeJsonResponse({ credentials: initialData.credentials });
      }

      if (input === '/admin-api/credentials/current') {
        return makeJsonResponse(initialData.currentCredential);
      }

      if (input === '/admin-api/stats') {
        return makeJsonResponse({
          credential_usage: {},
          model_usage: {},
        });
      }

      if (input === '/admin-api/access-keys') {
        return makeJsonResponse({ access_keys: initialData.accessKeys });
      }

      return makeJsonResponse({});
    });

    render(React.createElement(AdminConsole, { initialData }));

    fireEvent.click(screen.getByText('凭证管理'));
    await screen.findByText('Primary API Key');
    fireEvent.click(screen.getByRole('button', { name: '查看 Key' }));

    expect(await screen.findByText('当前 API Key')).toBeInTheDocument();
    expect(screen.getByText('sk-live-123')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);

    expect(await screen.findByText('编辑 API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key 名称')).toBeInTheDocument();
    expect(screen.getByText('保存 API Key')).toBeInTheDocument();
  });

  it('shows debug tab entries with upstream status code', async () => {
    render(React.createElement(AdminConsole, { initialData }));

    fireEvent.click(screen.getByText('Debug'));

    expect(await screen.findByText('/v1/responses')).toBeInTheDocument();
    expect(screen.getByText('上游状态: 202')).toBeInTheDocument();
    expect(screen.getByText('返回状态: 200')).toBeInTheDocument();
  });

  it('continuously refreshes debug data without replacing refresh settings', async () => {
    vi.useFakeTimers();
    let debugRequestCount = 0;

    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (input === '/admin-api/debug') {
        debugRequestCount += 1;

        return makeJsonResponse({
          ...initialData.debug,
          autoRefreshSeconds: 0,
          items: [
            {
              ...initialData.debug.items[0],
              id: `debug-refresh-${debugRequestCount}`,
              route: `/v1/debug-refresh-${debugRequestCount}`,
            },
          ],
        });
      }

      return makeJsonResponse({});
    });

    try {
      render(React.createElement(AdminConsole, { initialData }));
      fireEvent.click(screen.getByText('Debug'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(debugRequestCount).toBe(1);
      expect(screen.getByText('/v1/debug-refresh-1')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(debugRequestCount).toBe(2);
      expect(screen.getByText('/v1/debug-refresh-2')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-refresh debug data while debug is disabled', async () => {
    vi.useFakeTimers();
    const disabledDebugData: AdminConsoleInitialData = {
      ...initialData,
      debug: {
        ...initialData.debug,
        enabled: false,
      },
    };

    try {
      render(
        React.createElement(AdminConsole, { initialData: disabledDebugData }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(globalThis.fetch).not.toHaveBeenCalledWith('/admin-api/debug');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows credential routing labels with accurate developer conversion wording', async () => {
    render(React.createElement(AdminConsole, { initialData }));

    fireEvent.click(screen.getByText('凭证管理'));

    expect(
      await screen.findByText(
        'Responses 请求先转换为 Chat Completions 再发送至上游',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('转换为 Chat Completions 时保留 developer 角色'),
    ).toBeInTheDocument();
  });

  it('sends selected credential filename in api test requests', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, _init) => {
      if (input === '/admin-api/chat/completions') {
        return makeJsonResponse({
          choices: [{ message: { content: 'ok' } }],
        });
      }

      if (input === '/health') {
        return makeJsonResponse({ status: 'healthy' });
      }

      if (input === '/admin-api/credentials') {
        return makeJsonResponse({ credentials: initialData.credentials });
      }

      if (input === '/admin-api/credentials/current') {
        return makeJsonResponse(initialData.currentCredential);
      }

      if (input === '/admin-api/access-keys') {
        return makeJsonResponse({ access_keys: initialData.accessKeys });
      }

      if (input === '/admin-api/debug') {
        return makeJsonResponse(initialData.debug);
      }

      if (input === '/admin-api/stats') {
        return makeJsonResponse({
          credential_usage: {},
          model_usage: {},
        });
      }

      return makeJsonResponse({});
    });

    render(React.createElement(AdminConsole, { initialData }));

    fireEvent.click(screen.getByText('API 测试'));
    fireEvent.change(screen.getByLabelText('凭证'), {
      target: { value: 'cred-1.json' },
    });
    fireEvent.click(screen.getByText('发送测试'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/admin-api/chat/completions',
        expect.objectContaining({
          body: expect.stringContaining('"credential_filename":"cred-1.json"'),
        }),
      );
    });
  });
});
