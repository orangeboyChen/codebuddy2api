// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import Usage, { UsageProvider } from '@/app/usage/usage';
import { getMessages } from '@/lib/i18n/messages';

const renderUsage = () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      matches: false,
      media: '',
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });

  return render(
    <ConfigProvider motion={motion}>
      <NextIntlClientProvider locale="en-US" messages={getMessages('en-US')}>
        <UsageProvider
          value={{
            onAccessKeyChange: vi.fn(),
            onAutoRefreshSecondsChange: vi.fn(),
            onClearHistory: vi.fn(),
            onCredentialChange: vi.fn(),
            onHoverPoint: vi.fn(),
            onRangeChange: vi.fn(),
            onRefresh: vi.fn(),
            usage: {
              autoRefreshSeconds: 15,
              autoRefreshVisible: false,
              callSeries: [],
              credentialRows: [
                {
                  cacheHitTokens: 30,
                  callCount: 2,
                  credentialFilename: 'primary.json',
                  totalTokens: 120,
                },
              ],
              filters: { accessKeys: [], credentials: [] },
              hoveredPoint: null,
              lastUpdatedAt: '',
              loading: false,
              rangeSummary: {
                cacheHitTokens: 50,
                callCount: 4,
                totalTokens: 200,
              },
              request: { accessKey: [], credential: [], range: '24h' },
              tableRows: [
                {
                  cacheHitTokens: 60_032,
                  callCount: 3,
                  inputTokens: 38_232,
                  model: 'glm-5.1',
                  outputTokens: 192,
                  totalTokens: 98_456,
                },
                {
                  cacheHitTokens: 0,
                  callCount: 1,
                  inputTokens: 10,
                  model: 'glm-4.7',
                  outputTokens: 20,
                  totalTokens: 30,
                },
              ],
              tokenSeries: [],
            },
          }}
        >
          <Usage />
        </UsageProvider>
      </NextIntlClientProvider>
    </ConfigProvider>,
  );
};

describe('usage view', () => {
  it('shows filters before range summaries and credential token usage', () => {
    const { container } = renderUsage();

    expect(screen.getByLabelText('Time range')).toBeVisible();
    expect(screen.getByText('Credential usage')).toBeVisible();
    expect(screen.getByText('primary.json')).toBeVisible();
    expect(screen.getByText('200')).toBeVisible();
    expect(container.textContent).toMatch(
      /Time range[\s\S]*Calls[\s\S]*Credential usage/,
    );
  }, 60_000);

  it('splits model tokens into input, output, and cache lines', () => {
    const { container } = renderUsage();

    expect(container.textContent).toContain('Input / output');
    expect(screen.getByText('38,232 / 192')).toBeVisible();
    expect(screen.getByText('Cache ↓ 60,032')).toBeVisible();
    expect(screen.getByText('10 / 20')).toBeVisible();
    expect(screen.queryByText('Cache ↓ 0')).not.toBeInTheDocument();
  }, 60_000);
});
