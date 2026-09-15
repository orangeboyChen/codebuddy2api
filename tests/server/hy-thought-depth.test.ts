import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getHyThoughtDepthEnabled: vi.fn(),
  isHyModel: (model: string | undefined | null) =>
    typeof model === 'string' && model.trim().toLowerCase().startsWith('hy'),
}));

const { getHyThoughtDepthEnabled } = await import('@/lib/server/domain/config');
const {
  anthropicThinkingToHyEffort,
  openaiEffortToHyEffort,
  resolveHyChatThinking,
  resolveHyResponsesReasoning,
} = await import('@/lib/server/shared/hy-thought-depth');

const setEnabled = (enabled: boolean) => {
  vi.mocked(getHyThoughtDepthEnabled).mockResolvedValue(enabled);
};

describe('hy thought depth conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnabled(true);
  });

  describe('openaiEffortToHyEffort', () => {
    it('maps the Openai vocabulary onto the three Hy levels', () => {
      expect(openaiEffortToHyEffort('minimal')).toBe('no_think');
      expect(openaiEffortToHyEffort('none')).toBe('no_think');
      expect(openaiEffortToHyEffort('low')).toBe('low');
      expect(openaiEffortToHyEffort('medium')).toBe('low');
      expect(openaiEffortToHyEffort('high')).toBe('high');
      expect(openaiEffortToHyEffort('xhigh')).toBe('high');
      expect(openaiEffortToHyEffort('max')).toBe('high');
    });

    it('ignores case and surrounding whitespace', () => {
      expect(openaiEffortToHyEffort('  HIGH  ')).toBe('high');
    });

    it('returns undefined for unknown levels so the caller omits the field', () => {
      expect(openaiEffortToHyEffort('ultracode')).toBeUndefined();
      expect(openaiEffortToHyEffort('')).toBeUndefined();
      expect(openaiEffortToHyEffort(undefined)).toBeUndefined();
      expect(openaiEffortToHyEffort(42)).toBeUndefined();
    });
  });

  describe('anthropicThinkingToHyEffort', () => {
    it('treats a disabled thinking block as no_think', () => {
      expect(anthropicThinkingToHyEffort({ type: 'disabled' })).toBe(
        'no_think',
      );
    });

    it('reads a small budget as no_think', () => {
      expect(
        anthropicThinkingToHyEffort({ budget_tokens: 512, type: 'enabled' }),
      ).toBe('no_think');
    });

    it('reads a moderate budget as low', () => {
      expect(
        anthropicThinkingToHyEffort({ budget_tokens: 5_000, type: 'enabled' }),
      ).toBe('low');
      expect(
        anthropicThinkingToHyEffort({ budget_tokens: 8_192, type: 'enabled' }),
      ).toBe('low');
    });

    it('reads a large budget as high', () => {
      expect(
        anthropicThinkingToHyEffort({ budget_tokens: 10_000, type: 'enabled' }),
      ).toBe('high');
    });

    it('defaults an enabled block without a budget to high', () => {
      expect(anthropicThinkingToHyEffort({ type: 'enabled' })).toBe('high');
    });

    it('leaves unknown thinking shapes alone', () => {
      expect(anthropicThinkingToHyEffort(undefined)).toBeUndefined();
      expect(
        anthropicThinkingToHyEffort({ type: 'something-else' }),
      ).toBeUndefined();
    });
  });

  describe('resolveHyChatThinking', () => {
    it('passes an already-Hy value through untouched', async () => {
      await expect(
        resolveHyChatThinking('hy3', { reasoning_effort: 'high' }),
      ).resolves.toEqual({ reasoningEffort: 'high', thinking: undefined });
      await expect(
        resolveHyChatThinking('hy3', { reasoning_effort: 'no_think' }),
      ).resolves.toEqual({ reasoningEffort: 'no_think', thinking: undefined });
    });

    it('converts a Codex effort onto the Hy vocabulary', async () => {
      await expect(
        resolveHyChatThinking('hy3', { reasoning_effort: 'medium' }),
      ).resolves.toEqual({ reasoningEffort: 'low', thinking: undefined });
      await expect(
        resolveHyChatThinking('hy3', { reasoning_effort: 'xhigh' }),
      ).resolves.toEqual({ reasoningEffort: 'high', thinking: undefined });
    });

    it('converts Claude Code thinking and drops the original block', async () => {
      // Leaving the Anthropic block in place would still be rejected by the
      // upstream this translation exists to satisfy.
      await expect(
        resolveHyChatThinking('hy3', {
          thinking: { budget_tokens: 16_000, type: 'enabled' },
        }),
      ).resolves.toEqual({ reasoningEffort: 'high', thinking: undefined });
      await expect(
        resolveHyChatThinking('hy3', { thinking: { type: 'disabled' } }),
      ).resolves.toEqual({ reasoningEffort: 'no_think', thinking: undefined });
    });

    it('prefers the chat effort over the Anthropic thinking block', async () => {
      await expect(
        resolveHyChatThinking('hy3', {
          reasoning_effort: 'no_think',
          thinking: { budget_tokens: 16_000, type: 'enabled' },
        }),
      ).resolves.toEqual({ reasoningEffort: 'no_think', thinking: undefined });
    });

    it('keeps thinking for an unrecognized shape rather than dropping it', async () => {
      const thinking = { type: 'something-else' };

      await expect(resolveHyChatThinking('hy3', { thinking })).resolves.toEqual(
        { reasoningEffort: undefined, thinking },
      );
    });

    it('leaves non-Hy models untouched', async () => {
      await expect(
        resolveHyChatThinking('glm-5.1', { reasoning_effort: 'medium' }),
      ).resolves.toEqual({
        reasoningEffort: 'medium',
        thinking: undefined,
      });

      const thinking = { type: 'disabled' };
      await expect(
        resolveHyChatThinking('glm-5.1', { thinking }),
      ).resolves.toEqual({ reasoningEffort: undefined, thinking });
    });

    it('does not convert when the setting is off', async () => {
      setEnabled(false);

      await expect(
        resolveHyChatThinking('hy3', { reasoning_effort: 'medium' }),
      ).resolves.toEqual({
        reasoningEffort: 'medium',
        thinking: undefined,
      });

      const thinking = { budget_tokens: 16_000, type: 'enabled' };
      await expect(resolveHyChatThinking('hy3', { thinking })).resolves.toEqual(
        { reasoningEffort: undefined, thinking },
      );
    });

    it('matches Hy model ids case-insensitively', async () => {
      await expect(
        resolveHyChatThinking('HY3-IOA', { reasoning_effort: 'medium' }),
      ).resolves.toEqual({ reasoningEffort: 'low', thinking: undefined });
    });
  });

  describe('resolveHyResponsesReasoning', () => {
    it('rewrites a Codex effort onto the Hy vocabulary', async () => {
      await expect(
        resolveHyResponsesReasoning('hy3', {
          effort: 'medium',
          summary: 'auto',
        }),
      ).resolves.toEqual({ effort: 'low', summary: 'auto' });
    });

    it('keeps the rest of the reasoning object intact', async () => {
      await expect(
        resolveHyResponsesReasoning('hy3', {
          effort: 'xhigh',
          summary: 'auto',
        }),
      ).resolves.toEqual({ effort: 'high', summary: 'auto' });
    });

    it('leaves an already-Hy effort untouched', async () => {
      await expect(
        resolveHyResponsesReasoning('hy3', { effort: 'no_think' }),
      ).resolves.toEqual({ effort: 'no_think' });
    });

    it('leaves non-Hy models untouched', async () => {
      await expect(
        resolveHyResponsesReasoning('glm-5.1', { effort: 'medium' }),
      ).resolves.toEqual({ effort: 'medium' });
    });

    it('passes through a reasoning object with no effort', async () => {
      await expect(
        resolveHyResponsesReasoning('hy3', { summary: 'auto' }),
      ).resolves.toEqual({ summary: 'auto' });
      await expect(
        resolveHyResponsesReasoning('hy3', undefined),
      ).resolves.toBeUndefined();
    });

    it('does not convert when the setting is off', async () => {
      setEnabled(false);

      await expect(
        resolveHyResponsesReasoning('hy3', { effort: 'medium' }),
      ).resolves.toEqual({ effort: 'medium' });
    });
  });
});
