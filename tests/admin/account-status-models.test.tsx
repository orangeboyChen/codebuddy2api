// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';

import AccountStatus, {
  type AccountStatusModel,
} from '@/app/account-status/account-status';
import type { CredentialSummary } from '@/app/credentials/credentials';
import type { AppLocale } from '@/lib/i18n/routing';
import { type AppMessages, getMessages } from '@/lib/i18n/messages';

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
  messages: AppMessages | undefined = undefined,
) =>
  render(
    <ConfigProvider motion={motion}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages ?? getMessages(locale)}
      >
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

  it('rounds the token limits it abbreviates', () => {
    // The M branch divides without rounding, so a 1,048,576-token window used
    // to render as `上下文 1.048576M`.
    renderView([model({ contextWindow: 1_048_576, maxOutputTokens: 8_192 })]);

    expect(screen.getByText('上下文 1M')).toBeTruthy();
    expect(screen.getByText('输出 8K')).toBeTruthy();
  });

  it('copies a model id from the keyboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      renderView([model()]);

      const tag = document
        .querySelector('[data-model-id="glm-5.3"]')
        ?.closest('[role="button"]') as HTMLElement | null;

      expect(tag).not.toBeNull();
      expect(tag?.tabIndex).toBe(0);

      fireEvent.keyDown(tag as HTMLElement, { key: 'Enter' });

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('glm-5.3'));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('renders a model id only once when it is also the display name', () => {
    // The saved-id fallback produces `displayName === id`, so the row would
    // otherwise print the same string twice and every text locator for the
    // model id would match two elements.
    renderView([model({ displayName: 'bare-id', id: 'bare-id' })]);

    expect(screen.getAllByText('bare-id')).toHaveLength(1);
  });

  it('marks the copyable id so a long id wraps instead of overflowing', () => {
    renderView([
      model({ id: `${'glm-5.3-enterprise-preview-'.repeat(3)}end` }),
    ]);

    // The wrap rules in globals.scss hang off this class; without it a long id
    // keeps its intrinsic width and pushes the card past a 360px viewport.
    const tag = document
      .querySelector('[data-model-id]')
      ?.closest('.account-status-model-id');

    expect(tag).not.toBeNull();
  });

  it('renders a repeated id without colliding React keys', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    try {
      renderView([
        model({ displayName: 'First', id: 'same-id' }),
        model({ displayName: 'Second', id: 'same-id' }),
      ]);

      expect(screen.getAllByText('same-id')).toHaveLength(2);
      expect(error.mock.calls.flat().join('\n')).not.toMatch(/same key/);
    } finally {
      error.mockRestore();
    }
  });

  // Both descriptions are supplied so the assertion can tell the locale
  // branches apart: with only one of them, either branch renders it.
  it('shows the description that matches the console locale', () => {
    renderView(
      [
        model({
          descriptionEn: 'EN description',
          descriptionZh: 'ZH description',
        }),
      ],
      'zh-CN',
    );

    expect(screen.getByText('ZH description')).toBeTruthy();
    expect(screen.queryByText('EN description')).toBeNull();
  });

  it('falls back to the English description outside Chinese locales', () => {
    renderView(
      [
        model({
          descriptionEn: 'EN description',
          descriptionZh: 'ZH description',
        }),
      ],
      'en-US',
    );

    expect(screen.getByText('EN description')).toBeTruthy();
    expect(screen.queryByText('ZH description')).toBeNull();
    expect(screen.getByText('Enterprise')).toBeTruthy();
  });

  it('shows the Chinese description when upstream ships no English one', () => {
    renderView([model({ descriptionEn: undefined })], 'en-US');

    expect(screen.getByText('通用模型')).toBeTruthy();
  });

  it('labels the credit multiplier, not a credit balance, in English', () => {
    renderView([model()], 'en-US');

    // The value is a billing rate (`x3.33`), so "Credits" reads as a balance.
    expect(screen.getByText('Multiplier x3.33')).toBeTruthy();
    expect(screen.queryByText(/^Credits/)).toBeNull();
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

  it('announces whether the model list is expanded', () => {
    const models = Array.from({ length: 10 }, (_, index) =>
      model({ displayName: `Model ${index}`, id: `model-${index}` }),
    );
    renderView(models);

    const collapsed = screen.getByRole('button', { name: /展开全部/ });

    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(collapsed.getAttribute('aria-controls')).toBeTruthy();

    fireEvent.click(collapsed);

    expect(
      screen
        .getByRole('button', { name: '收起' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('keys badges by field so two alike labels do not collide', () => {
    const messages = JSON.parse(
      JSON.stringify(getMessages('zh-CN')),
    ) as AppMessages;
    messages.Admin.accountStatus.modelFree =
      messages.Admin.accountStatus.modelEnterprise;
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      renderView([model({ isFree: true })], 'zh-CN', messages);

      expect(screen.getAllByText('企业版')).toHaveLength(2);
      expect(error.mock.calls.flat().join('\n')).not.toMatch(/same key/);
    } finally {
      error.mockRestore();
    }
  });

  it('renders the details upstream declares beside the limits', () => {
    renderView([
      model({
        capabilityTags: ['craft', 'text-to-image'],
        contextLengths: [200000, 1_000_000],
        defaultEffort: 'high',
        isDefault: true,
        maxAllowedSize: 192000,
        onlyReasoning: true,
        relatedModels: { lite: 'glm-5.3-lite' },
        supportedEfforts: ['low', 'high'],
        vendor: 'e',
      }),
    ]);

    expect(screen.getByText('默认')).toBeTruthy();
    expect(screen.getByText('仅思考')).toBeTruthy();
    expect(screen.getByText('厂商 e')).toBeTruthy();
    expect(screen.getByText('单次上限 192K')).toBeTruthy();
    // Both lengths are abbreviated with the same ruler as the context window.
    expect(screen.getByText('可选上下文 200K / 1M')).toBeTruthy();
    expect(screen.getByText('默认强度 high')).toBeTruthy();
    expect(screen.getByText('可选强度 low, high')).toBeTruthy();
    expect(screen.getByText('变体 lite: glm-5.3-lite')).toBeTruthy();
    expect(screen.getByText('craft')).toBeTruthy();
    expect(screen.getByText('text-to-image')).toBeTruthy();
  });

  it('renders a promotion upstream attaches to a model', () => {
    renderView([
      model({
        promotion: {
          discountedCredits: 'x0.00',
          endsAt: '2099-10-01T00:00:00.000Z',
          label: '限时免费',
          textEn: 'Free until then',
          textZh: '到点恢复原价',
        },
      }),
    ]);

    expect(screen.getByText('限时免费')).toBeTruthy();
    // The discount is a multiplier, so it replaces the plain one rather than
    // sitting beside it.
    expect(screen.getByText('倍率 x3.33 → x0.00')).toBeTruthy();
    expect(screen.getByText('到点恢复原价')).toBeTruthy();
    expect(screen.getByText('优惠至 2099-10-01')).toBeTruthy();
  });

  it('renders the English copy of a promotion outside Chinese locales', () => {
    renderView(
      [
        model({
          promotion: {
            label: '限时免费',
            textEn: 'Free until then',
            textZh: '到点恢复原价',
          },
        }),
      ],
      'en-US',
    );

    expect(screen.getByText('Free until then')).toBeTruthy();
    expect(screen.queryByText('到点恢复原价')).toBeNull();
    // The badge is upstream's own copy, in whichever language it arrived.
    expect(screen.getByText('限时免费')).toBeTruthy();
    expect(screen.getByText('Multiplier x3.33')).toBeTruthy();
  });

  it('renders the tier upstream requires for a model', () => {
    renderView([model({ tier: { label: '旗舰版', level: 'flagship' } })]);

    expect(screen.getByText('旗舰版')).toBeTruthy();
  });

  it('omits the details upstream does not advertise', () => {
    renderView([model()]);

    expect(screen.queryByText(/厂商/)).toBeNull();
    expect(screen.queryByText(/单次上限/)).toBeNull();
    expect(screen.queryByText(/可选上下文/)).toBeNull();
    expect(screen.queryByText(/默认强度/)).toBeNull();
    expect(screen.queryByText(/可选强度/)).toBeNull();
    expect(screen.queryByText(/变体/)).toBeNull();
    expect(screen.queryByText('默认')).toBeNull();
    expect(screen.queryByText('仅思考')).toBeNull();
  });

  it('prints the promotion badge once when the copy repeats it', () => {
    renderView([
      model({
        promotion: {
          label: '限时免费',
          textEn: '限时免费',
          textZh: '限时免费',
        },
      }),
    ]);

    // The badge and the copy are the same sentence upstream; printing both
    // would stutter and leave two matches for one string.
    expect(screen.getAllByText('限时免费')).toHaveLength(1);
  });

  it('leaves the multiplier alone when a promotion quotes it unchanged', () => {
    renderView([
      model({ credits: 'x3.33', promotion: { discountedCredits: 'x3.33' } }),
    ]);

    expect(screen.getByText('倍率 x3.33')).toBeTruthy();
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it('marks the capability tags so a 360px viewport can break them', () => {
    renderView([model({ capabilityTags: ['text-to-image'] })]);

    // The wrap rules hang off this class; an unbreakable tag is what pushes a
    // narrow card past the viewport.
    const tag = screen
      .getByText('text-to-image')
      .closest('.account-status-model-capability');

    expect(tag).not.toBeNull();
  });

  it('renders the details in Japanese with the English promotion copy', () => {
    renderView(
      [
        model({
          defaultEffort: 'high',
          promotion: { label: '限定無料', textEn: 'Free for now' },
          vendor: 'e',
        }),
      ],
      'ja-JP',
    );

    expect(screen.getByText('ベンダー e')).toBeTruthy();
    expect(screen.getByText('デフォルト強度 high')).toBeTruthy();
    expect(screen.getByText('限定無料')).toBeTruthy();
    // Upstream ships Chinese and English only, so Japanese reads the English.
    expect(screen.getByText('Free for now')).toBeTruthy();
  });

  it('reports an account with no models', () => {
    renderView([]);

    expect(screen.getByText('暂无模型')).toBeTruthy();
  });
});
