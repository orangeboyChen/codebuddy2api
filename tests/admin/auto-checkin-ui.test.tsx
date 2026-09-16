// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import AccountStatus from '@/app/account-status/account-status';
import type { CredentialSummary } from '@/app/credentials/credentials';
import { getMessages } from '@/lib/i18n/messages';

const makeJsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const credential = (
  overrides: Partial<CredentialSummary> = {},
): CredentialSummary => ({
  auto_checkin_enabled: false,
  auto_checkin_time: '09:00',
  created_at: null,
  domain: 'copilot.tencent.com',
  email: 'tester@example.com',
  enterprise_id: null,
  expires_at: null,
  expires_in: null,
  filename: 'one.json',
  first_message_role_to_system: false,
  has_refresh_token: false,
  index: 0,
  is_expired: false,
  name: null,
  responses_passthrough: false,
  scope: null,
  session_state: null,
  tenant_id: null,
  time_remaining: null,
  time_remaining_str: '',
  token_type: 'Bearer',
  upstream_protocol: 'chat',
  user_id: 'tester',
  ...overrides,
});

const snapshot = (filename: string) => ({
  checkin: { claimed: false, message: null },
  credits: {
    total: 100,
    used: 40,
    remaining: 60,
    plan: 'Pro',
    resetAt: null,
  },
  error: null,
  filename,
  models: [],
  queriedAt: new Date().toISOString(),
});

const renderView = (credentials: CredentialSummary[]) =>
  render(
    <ConfigProvider motion={motion}>
      <NextIntlClientProvider locale="zh-CN" messages={getMessages('zh-CN')}>
        <AccountStatus
          credentials={credentials}
          initialStatuses={credentials.map((item) => snapshot(item.filename))}
        />
      </NextIntlClientProvider>
    </ConfigProvider>,
  );

const findSwitch = (): HTMLButtonElement => {
  const switches = screen
    .getAllByRole('switch')
    .filter((element) => element instanceof HTMLButtonElement);

  // The refresh/check-in controls are buttons; the auto check-in switch is the
  // only switch on the card.
  const [first] = switches;

  if (!first) throw new Error('Auto check-in switch was not rendered');

  return first;
};

describe('account status auto check-in', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeJsonResponse({ autoCheckin: {} })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the automatic check-in label', () => {
    renderView([credential()]);

    expect(screen.getByText('自动签到')).toBeTruthy();
  });

  it('is off by default', () => {
    renderView([credential()]);

    expect(findSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('reflects a stored enabled schedule', () => {
    renderView([
      credential({
        auto_checkin_enabled: true,
        auto_checkin_time: '14:30',
      }),
    ]);

    expect(findSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('saves the new state when toggled on', async () => {
    const fetchMock = vi.mocked(fetch);
    renderView([credential()]);

    fireEvent.click(findSwitch());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    expect(body).toMatchObject({
      action: 'auto-checkin',
      enabled: true,
      filename: 'one.json',
    });

    // Optimistic update: the switch moves before the response is confirmed.
    expect(findSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('reverts the switch when the save fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeJsonResponse({ error: 'Credential is unavailable' }, 400),
      ),
    );
    renderView([credential()]);

    fireEvent.click(findSwitch());

    await waitFor(() => {
      expect(findSwitch().getAttribute('aria-checked')).toBe('false');
    });
  });

  it('renders one control per account', () => {
    renderView([
      credential({ filename: 'a.json' }),
      credential({ filename: 'b.json', index: 1 }),
    ]);

    expect(screen.getAllByText('自动签到')).toHaveLength(2);
  });
});
