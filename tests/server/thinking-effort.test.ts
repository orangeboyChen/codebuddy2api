import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: async () => 'https://upstream.test',
  getDefaultModel: async () => 'glm-5.1',
}));

const {
  anthropicThinkingToEffort,
  findModelThinkingCapabilities,
  pickSupportedEffort,
  resolveChatThinking,
  resolveResponsesReasoning,
  toUpstreamEffort,
} = await import('@/lib/server/shared/thinking-effort');
const { buildUpstreamBody } =
  await import('@/lib/server/proxy/codebuddy/upstream');
const { normalizeResponsesUpstreamBody } =
  await import('@/lib/server/proxy/codebuddy/responses-request');

const catalog = (models: unknown[]): Record<string, unknown> => ({
  supported_models_detail: JSON.stringify(models),
});

/**
 * A catalog in the shape upstream ships it, with the effort lists the live
 * `/v3/config` reports: most models advertise none at all, and the ones that do
 * use `low` / `high` / `max`.
 */
const upstreamCatalog = catalog([
  {
    id: 'glm-5.3',
    supportsReasoning: true,
    supportedEfforts: ['low', 'high', 'max'],
  },
  { id: 'hy3-x', supportsReasoning: true, supportedEfforts: ['low', 'high'] },
  { id: 'hy4-preview', supportsReasoning: true, supportedEfforts: ['high'] },
  { id: 'glm-5.3-lite', supportsReasoning: false },
  { id: 'sparse', supportsReasoning: true },
]);

describe('anthropicThinkingToEffort', () => {
  it('reads a disabled block as no thinking', () => {
    expect(anthropicThinkingToEffort({ type: 'disabled' })).toBe('off');
    expect(anthropicThinkingToEffort({ type: 'none' })).toBe('off');
    expect(anthropicThinkingToEffort({ type: 'off' })).toBe('off');
  });

  it('buckets the token budget onto a level', () => {
    expect(
      anthropicThinkingToEffort({ budget_tokens: 1_024, type: 'enabled' }),
    ).toBe('minimal');
    expect(
      anthropicThinkingToEffort({ budget_tokens: 2_048, type: 'enabled' }),
    ).toBe('minimal');
    expect(
      anthropicThinkingToEffort({ budget_tokens: 5_000, type: 'enabled' }),
    ).toBe('medium');
    expect(
      anthropicThinkingToEffort({ budget_tokens: 8_192, type: 'enabled' }),
    ).toBe('medium');
    expect(
      anthropicThinkingToEffort({ budget_tokens: 32_000, type: 'enabled' }),
    ).toBe('high');
  });

  it('reads an adaptive block and a budget-less block as deep thinking', () => {
    expect(anthropicThinkingToEffort({ type: 'adaptive' })).toBe('high');
    expect(anthropicThinkingToEffort({ type: 'enabled' })).toBe('high');
    expect(
      anthropicThinkingToEffort({ budget_tokens: Number.NaN, type: 'enabled' }),
    ).toBe('high');
  });

  it('leaves a block that is not a thinking request alone', () => {
    expect(anthropicThinkingToEffort(undefined)).toBeUndefined();
    expect(
      anthropicThinkingToEffort({ type: 'something-else' }),
    ).toBeUndefined();
  });
});

describe('toUpstreamEffort', () => {
  it('maps the ladder onto the vocabulary the upstream uses', () => {
    expect(toUpstreamEffort('low')).toBe('low');
    expect(toUpstreamEffort('medium')).toBe('medium');
    expect(toUpstreamEffort('high')).toBe('high');
    expect(toUpstreamEffort('max')).toBe('max');
  });

  it('sends the nearest effort still upstream when a level is unknown to it', () => {
    // `xhigh` is not a spelling the upstream catalog uses anywhere.
    expect(toUpstreamEffort('xhigh')).toBe('high');
    // Thinking cannot be turned off: every model that advertises efforts
    // declares `canDisableThinking: false`, so `low` is the shallowest on offer.
    expect(toUpstreamEffort('off')).toBe('low');
    expect(toUpstreamEffort('minimal')).toBe('low');
    expect(toUpstreamEffort('no_think')).toBe('low');
  });

  it('has nothing to say about a level it cannot place', () => {
    expect(toUpstreamEffort('ultracode')).toBeUndefined();
    expect(toUpstreamEffort(undefined)).toBeUndefined();
    expect(toUpstreamEffort('  ')).toBeUndefined();
    expect(toUpstreamEffort('constructor')).toBeUndefined();
  });
});

describe('pickSupportedEffort', () => {
  it('keeps an effort the model advertises, in its own spelling', () => {
    expect(pickSupportedEffort('high', ['low', 'high'])).toBe('high');
    expect(pickSupportedEffort('  MAX  ', ['low', 'Max'])).toBe('Max');
  });

  it('snaps a deeper request down onto the deepest level supported', () => {
    expect(pickSupportedEffort('xhigh', ['low', 'high'])).toBe('high');
    expect(pickSupportedEffort('medium', ['low', 'high'])).toBe('high');
  });

  it('snaps a shallower request up onto the shallowest level supported', () => {
    expect(pickSupportedEffort('off', ['low', 'high'])).toBe('low');
    expect(pickSupportedEffort('minimal', ['high', 'max'])).toBe('high');
  });

  it('ignores a level it cannot place on the ladder', () => {
    expect(pickSupportedEffort('ultracode', ['low', 'high'])).toBeUndefined();
    expect(pickSupportedEffort('constructor', ['low', 'high'])).toBeUndefined();
    expect(pickSupportedEffort('low', ['constructor'])).toBeUndefined();
  });

  it('has nothing to snap onto without a request or a list', () => {
    expect(pickSupportedEffort('low', undefined)).toBeUndefined();
    expect(pickSupportedEffort('low', [])).toBeUndefined();
    expect(pickSupportedEffort(undefined, ['low'])).toBeUndefined();
    expect(pickSupportedEffort('', ['low'])).toBeUndefined();
    expect(pickSupportedEffort('   ', ['low'])).toBeUndefined();
    expect(pickSupportedEffort('low', ['  '])).toBeUndefined();
  });
});

describe('findModelThinkingCapabilities', () => {
  it('reads what upstream said about a model', () => {
    expect(findModelThinkingCapabilities(upstreamCatalog, 'hy3-x')).toEqual({
      supportsReasoning: true,
      supportedEfforts: ['low', 'high'],
    });
  });

  it('is undefined for a model the catalog does not describe', () => {
    expect(
      findModelThinkingCapabilities(upstreamCatalog, 'unknown'),
    ).toBeUndefined();
    expect(
      findModelThinkingCapabilities(upstreamCatalog, undefined),
    ).toBeUndefined();
    expect(
      findModelThinkingCapabilities(upstreamCatalog, '   '),
    ).toBeUndefined();
    expect(findModelThinkingCapabilities({}, 'hy3-x')).toBeUndefined();
    expect(
      findModelThinkingCapabilities(
        { supported_models_detail: 'not json' },
        'hy3-x',
      ),
    ).toBeUndefined();
  });
});

describe('resolveChatThinking', () => {
  it('sends an effort the model advertises', () => {
    expect(
      resolveChatThinking(upstreamCatalog, 'hy3-x', {
        reasoning_effort: 'xhigh',
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });

    expect(
      resolveChatThinking(upstreamCatalog, 'glm-5.3', {
        reasoning_effort: 'max',
      }),
    ).toEqual({ reasoningEffort: 'max', thinking: undefined });
  });

  it('translates Claude Code thinking even when the catalog is silent', () => {
    // The upstream takes an effort, not an Anthropic `thinking` block, so the
    // block is translated rather than forwarded into a shape nothing reads.
    expect(
      resolveChatThinking(upstreamCatalog, 'hy3', {
        thinking: { budget_tokens: 32_000, type: 'enabled' },
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });

    expect(
      resolveChatThinking(upstreamCatalog, 'hy3', {
        thinking: { type: 'disabled' },
      }),
    ).toEqual({ reasoningEffort: 'low', thinking: undefined });
  });

  it('falls back to the upstream vocabulary for a model with no effort list', () => {
    expect(
      resolveChatThinking(upstreamCatalog, 'sparse', {
        reasoning_effort: 'xhigh',
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });

    expect(
      resolveChatThinking(upstreamCatalog, 'sparse', {
        reasoning_effort: 'minimal',
      }),
    ).toEqual({ reasoningEffort: 'low', thinking: undefined });
  });

  it('drops both fields for a model that cannot reason', () => {
    expect(
      resolveChatThinking(upstreamCatalog, 'glm-5.3-lite', {
        reasoning_effort: 'high',
        thinking: { budget_tokens: 32_000, type: 'enabled' },
      }),
    ).toEqual({ reasoningEffort: undefined, thinking: undefined });
  });

  it('leaves a request it cannot place alone', () => {
    expect(
      resolveChatThinking(upstreamCatalog, 'hy3-x', {
        reasoning_effort: 'ultracode',
      }),
    ).toEqual({ reasoningEffort: 'ultracode', thinking: undefined });

    // A thinking block that is not a thinking request.
    expect(
      resolveChatThinking(upstreamCatalog, 'hy3-x', {
        thinking: { type: 'something-else' },
      }),
    ).toEqual({
      reasoningEffort: undefined,
      thinking: { type: 'something-else' },
    });
  });

  it('does not invent an effort a caller never asked for', () => {
    expect(resolveChatThinking(upstreamCatalog, 'hy3-x', {})).toEqual({
      reasoningEffort: undefined,
      thinking: undefined,
    });
  });
});

describe('resolveResponsesReasoning', () => {
  it('snaps the requested effort onto the level the model advertises', () => {
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'hy3-x', {
        effort: 'xhigh',
        summary: 'auto',
      }),
    ).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('falls back to the upstream vocabulary when the catalog is silent', () => {
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'hy3', { effort: 'xhigh' }),
    ).toEqual({ effort: 'high' });

    expect(
      resolveResponsesReasoning(upstreamCatalog, 'sparse', { effort: 'none' }),
    ).toEqual({ effort: 'low' });
  });

  it('drops the whole reasoning object for a model that cannot reason', () => {
    // `summary` is itself a request for reasoning, so it cannot stay behind.
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'glm-5.3-lite', {
        effort: 'high',
        summary: 'auto',
      }),
    ).toBeUndefined();
  });

  it('leaves a reasoning object it cannot place alone', () => {
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'hy3-x', {
        effort: 'ultracode',
      }),
    ).toEqual({ effort: 'ultracode' });
  });

  it('passes through a reasoning object with no effort', () => {
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'hy3-x', { summary: 'auto' }),
    ).toEqual({ summary: 'auto' });
    expect(
      resolveResponsesReasoning(upstreamCatalog, 'hy3-x', undefined),
    ).toBeUndefined();
  });
});

describe('upstream wiring', () => {
  const makeContext = (credentialData: Record<string, unknown>) =>
    ({
      accessKeyId: null,
      accessKeyName: null,
      auth: {
        bearerToken: 'token',
        credentialData,
        type: 'bearer',
        userId: 'user',
      },
      credentialFilename: null,
      preferences: {
        firstMessageRoleToSystem: false,
        firstSystemMessageRoleToUser: false,
        upstreamProtocol: 'chat',
      },
    }) as unknown as Parameters<typeof buildUpstreamBody>[1];

  const chatBody = {
    messages: [{ content: 'hello', role: 'user' }],
    model: 'hy3-x',
  } as unknown as Parameters<typeof buildUpstreamBody>[0];

  it('sends the effort the model advertises for a chat request', async () => {
    const upstream = await buildUpstreamBody(
      { ...chatBody, thinking: { budget_tokens: 32_000, type: 'enabled' } },
      makeContext(upstreamCatalog),
    );

    expect(upstream.reasoning_effort).toBe('high');
    expect(upstream.thinking).toBeUndefined();
  });

  it('sends nothing for a model that cannot reason', async () => {
    const upstream = await buildUpstreamBody(
      { ...chatBody, model: 'glm-5.3-lite', reasoning_effort: 'high' },
      makeContext(upstreamCatalog),
    );

    expect(upstream.reasoning_effort).toBeUndefined();
    expect(upstream.thinking).toBeUndefined();
  });

  it('snaps a Responses effort onto the level the model advertises', async () => {
    const upstream = await normalizeResponsesUpstreamBody(
      {
        input: [{ content: 'hello', role: 'user' }],
        model: 'hy3-x',
        reasoning: { effort: 'xhigh', summary: 'auto' },
      },
      upstreamCatalog,
    );

    expect(upstream.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('translates a Responses effort for an unknown model', async () => {
    const upstream = await normalizeResponsesUpstreamBody(
      {
        input: [{ content: 'hello', role: 'user' }],
        model: 'hy3',
        reasoning: { effort: 'xhigh' },
      },
      upstreamCatalog,
    );

    expect(upstream.reasoning).toEqual({ effort: 'high' });
  });
});
