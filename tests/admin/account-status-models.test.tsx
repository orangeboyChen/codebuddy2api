// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import AccountStatus, {
  type AccountStatusModel,
} from '@/app/account-status/account-status';
import type { CredentialSummary } from '@/app/credentials/credentials';
import type { AppLocale } from '@/lib/i18n/routing';
import { getMessages } from '@/lib/i18n/messages';

const credential = (): CredentialSummary => ({
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
});

const snapshot = (models: AccountStatusModel[], filename = 'one.json') => ({
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
  models,
  queriedAt: new Date().toISOString(),
});

const renderView = (
  models: AccountStatusModel[],
  locale: AppLocale = 'zh-CN',
) =>
  render(
    <ConfigProvider motion={motion}>
      <NextIntlClientProvider locale={locale} messages={getMessages(locale)}>
        <AccountStatus
          credentials={[credential()]}
          initialStatuses={[snapshot(models)]}
        />
      </NextIntlClientProvider>
    </ConfigProvider>,
  );

const model = (
  overrides: Partial<AccountStatusModel> = {},
): AccountStatusModel => ({
  contextWindow: 200000,
  credits: 'x3.33',
  descriptionEn: 'General purpose model',
  descriptionZh: '通用模型',
  displayName: 'GLM 5.3',
  id: 'glm-5.3',
  isEnterprise: true,
  maxOutputTokens: 64000,
  supportsImages: true,
  supportsReasoning: true,
  supportsToolCall: true,
  ...overrides,
});

describe('account status model details', () => {
  it('renders the metadata upstream advertises for a model', () => {
    renderView([model()]);

    expect(screen.getByText('GLM 5.3')).toBeTruthy();
    expect(screen.getByText('glm-5.3')).toBeTruthy();
    expect(screen.getByText('倍率 x3.33')).toBeTruthy();
    expect(screen.getByText('企业版')).toBeTruthy();
    expect(screen.getByText('通用模型')).toBeTruthy();
    expect(screen.getByText('上下文 200K')).toBeTruthy();
    expect(screen.getByText('输出 64K')).toBeTruthy();
    expect(screen.getByText('图像')).toBeTruthy();
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('推理')).toBeTruthy();
  });

  it('renders a model id only once when it is also the display name', () => {
    // The saved-id fallback produces `displayName === id`, so the row would
    // otherwise print the same string twice and every text locator for the
    // model id would match two elements.
    renderView([model({ displayName: 'bare-id', id: 'bare-id' })]);

    expect(screen.getAllByText('bare-id')).toHaveLength(1);
  });

  it('falls back to the English description outside Chinese locales', () => {
    renderView([model({ descriptionZh: undefined })], 'en-US');

    expect(screen.getByText('General purpose model')).toBeTruthy();
    expect(screen.getByText('Enterprise')).toBeTruthy();
  });

  it('omits the fields upstream does not advertise', () => {
    renderView([
      model({
        contextWindow: undefined,
        credits: undefined,
        maxInputTokens: 200000,
      }),
    ]);

    expect(screen.queryByText(/x3\.33/)).toBeNull();
    // Without a declared context window the input ceiling stands in for it.
    expect(screen.getByText('上下文 200K')).toBeTruthy();
  });

  it('collapses long model lists and expands them on demand', () => {
    const models = Array.from({ length: 10 }, (_, index) =>
      model({ displayName: `Model ${index}`, id: `model-${index}` }),
    );
    renderView(models);

    expect(screen.getAllByText(/^model-\d$/)).toHaveLength(8);

    fireEvent.click(screen.getByText('展开全部（10 个）'));

    expect(screen.getAllByText(/^model-\d$/)).toHaveLength(10);
    expect(screen.getByText('收起')).toBeTruthy();

    fireEvent.click(screen.getByText('收起'));

    expect(screen.getAllByText(/^model-\d$/)).toHaveLength(8);
  });

  it('reports an account with no models', () => {
    renderView([]);

    expect(screen.getByText('暂无模型')).toBeTruthy();
  });
});
