import { describe, expect, it, vi } from 'vitest';

// The Hy conversion is exercised on its own in `hy-thought-depth.test.ts`;
// here it is a pass-through so the model-aware step can be read in isolation.
vi.mock('@/lib/server/shared/hy-thought-depth', () => ({
  resolveHyChatThinking: async (
    _model: string | undefined,
    body: {
      reasoning_effort?: string;
      thinking?: { budget_tokens?: number; type?: string };
    },
  ) => ({ reasoningEffort: body.reasoning_effort, thinking: body.thinking }),
  resolveHyResponsesReasoning: async (
    _model: string | undefined,
    reasoning: Record<string, unknown> | undefined,
  ) => reasoning,
}));

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: async () => 'https://upstream.test',
  getDefaultModel: async () => 'glm-5.1',
  getHyThoughtDepthEnabled: async () => false,
  isHyModel: () => false,
}));

const {
  anthropicThinkingToEffort,
  findModelThinkingCapabilities,
  pickSupportedEffort,
  resolveModelChatThinking,
  resolveModelResponsesReasoning,
} = await import('@/lib/server/shared/thinking-effort');
const { buildUpstreamBody } =
  await import('@/lib/server/proxy/codebuddy/upstream');
const { normalizeResponsesUpstreamBody } =
  await import('@/lib/server/proxy/codebuddy/responses-request');

const catalog = (models: unknown[]): Record<string, unknown> => ({
  supported_models_detail: JSON.stringify(models),
});

/**
 * A catalog entry in the shape upstream ships it, already normalized the way
 * `getCredentialSupportedModelDetails` reads it back.
 */
const glmCatalog = catalog([
  {
    id: 'glm-5.3',
    defaultEffort: 'high',
    supportsReasoning: true,
    supportedEfforts: ['low', 'medium', 'high'],
  },
  {
    id: 'glm-5.3-lite',
    supportsReasoning: false,
  },
  {
    id: 'hy3-ioa',
    supportsReasoning: true,
    supportedEfforts: ['no_think', 'low', 'high'],
  },
  {
    id: 'sparse',
    supportsReasoning: true,
  },
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

describe('pickSupportedEffort', () => {
  it('keeps an effort the model advertises, in its own spelling', () => {
    expect(pickSupportedEffort('high', ['low', 'medium', 'high'])).toBe('high');
    expect(pickSupportedEffort('  HIGH  ', ['low', 'High'])).toBe('High');
    expect(pickSupportedEffort('no_think', ['no_think', 'low'])).toBe(
      'no_think',
    );
  });

  it('snaps a deeper request down onto the deepest level supported', () => {
    expect(pickSupportedEffort('xhigh', ['low', 'medium', 'high'])).toBe(
      'high',
    );
    expect(pickSupportedEffort('max', ['low', 'medium', 'high'])).toBe('high');
  });

  it('snaps a shallower request up onto the shallowest level supported', () => {
    expect(pickSupportedEffort('off', ['low', 'medium', 'high'])).toBe('low');
    expect(pickSupportedEffort('minimal', ['medium', 'high'])).toBe('medium');
  });

  it('breaks a tie towards the deeper level', () => {
    expect(pickSupportedEffort('medium', ['low', 'high'])).toBe('high');
    expect(pickSupportedEffort('minimal', ['off', 'low'])).toBe('low');
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
    expect(findModelThinkingCapabilities(glmCatalog, 'glm-5.3')).toEqual({
      supportsReasoning: true,
      supportedEfforts: ['low', 'medium', 'high'],
    });
  });

  it('is undefined for a model the catalog does not describe', () => {
    expect(
      findModelThinkingCapabilities(glmCatalog, 'unknown'),
    ).toBeUndefined();
    expect(
      findModelThinkingCapabilities(glmCatalog, undefined),
    ).toBeUndefined();
    expect(findModelThinkingCapabilities(glmCatalog, '   ')).toBeUndefined();
    expect(findModelThinkingCapabilities({}, 'glm-5.3')).toBeUndefined();
    expect(
      findModelThinkingCapabilities(
        { supported_models_detail: 'not json' },
        'glm-5.3',
      ),
    ).toBeUndefined();
  });
});

describe('resolveModelChatThinking', () => {
  it('snaps a requested effort onto the level the model advertises', () => {
    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3', {
        reasoning_effort: 'xhigh',
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });
  });

  it('translates an Anthropic thinking block into the upstream effort', () => {
    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3', {
        thinking: { budget_tokens: 32_000, type: 'enabled' },
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });

    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3', {
        thinking: { type: 'disabled' },
      }),
    ).toEqual({ reasoningEffort: 'low', thinking: undefined });
  });

  it('keeps the vocabulary a model spells its own efforts in', () => {
    expect(
      resolveModelChatThinking(glmCatalog, 'hy3-ioa', {
        reasoning_effort: 'medium',
      }),
    ).toEqual({ reasoningEffort: 'high', thinking: undefined });

    expect(
      resolveModelChatThinking(glmCatalog, 'hy3-ioa', {
        reasoning_effort: 'none',
      }),
    ).toEqual({ reasoningEffort: 'no_think', thinking: undefined });
  });

  it('drops both fields for a model that cannot reason', () => {
    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3-lite', {
        reasoning_effort: 'high',
        thinking: { budget_tokens: 32_000, type: 'enabled' },
      }),
    ).toEqual({ reasoningEffort: undefined, thinking: undefined });
  });

  it('leaves a request it cannot place alone', () => {
    // A thinking block that is not a thinking request.
    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3', {
        thinking: { type: 'something-else' },
      }),
    ).toEqual({
      reasoningEffort: undefined,
      thinking: { type: 'something-else' },
    });

    // An effort no ladder recognizes.
    expect(
      resolveModelChatThinking(glmCatalog, 'glm-5.3', {
        reasoning_effort: 'ultracode',
      }),
    ).toEqual({ reasoningEffort: 'ultracode', thinking: undefined });
  });

  it('leaves a model the catalog does not describe alone', () => {
    const thinking = { budget_tokens: 32_000, type: 'enabled' };

    expect(
      resolveModelChatThinking(glmCatalog, 'unknown', { thinking }),
    ).toEqual({ reasoningEffort: undefined, thinking });

    // Advertised as able to reason, but with no effort list to check against.
    expect(
      resolveModelChatThinking(glmCatalog, 'sparse', { thinking }),
    ).toEqual({ reasoningEffort: undefined, thinking });
  });

  it('does not invent an effort a caller never asked for', () => {
    expect(resolveModelChatThinking(glmCatalog, 'glm-5.3', {})).toEqual({
      reasoningEffort: undefined,
      thinking: undefined,
    });
  });
});

describe('resolveModelResponsesReasoning', () => {
  it('snaps the requested effort onto the level the model advertises', () => {
    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3', {
        effort: 'xhigh',
        summary: 'auto',
      }),
    ).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('drops the effort for a model that cannot reason', () => {
    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3-lite', {
        effort: 'high',
        summary: 'auto',
      }),
    ).toEqual({ summary: 'auto' });

    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3-lite', {
        effort: 'high',
      }),
    ).toBeUndefined();
  });

  it('leaves a reasoning object it cannot place alone', () => {
    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3', {
        effort: 'ultracode',
      }),
    ).toEqual({ effort: 'ultracode' });

    expect(
      resolveModelResponsesReasoning(glmCatalog, 'unknown', {
        effort: 'xhigh',
      }),
    ).toEqual({ effort: 'xhigh' });

    expect(
      resolveModelResponsesReasoning(glmCatalog, 'sparse', { effort: 'xhigh' }),
    ).toEqual({ effort: 'xhigh' });
  });

  it('passes through a reasoning object with no effort', () => {
    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3', {
        summary: 'auto',
      }),
    ).toEqual({ summary: 'auto' });
    expect(
      resolveModelResponsesReasoning(glmCatalog, 'glm-5.3', undefined),
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
    model: 'glm-5.3',
  } as unknown as Parameters<typeof buildUpstreamBody>[0];

  it('sends the effort the model advertises for a chat request', async () => {
    const upstream = await buildUpstreamBody(
      { ...chatBody, thinking: { budget_tokens: 32_000, type: 'enabled' } },
      makeContext(glmCatalog),
    );

    expect(upstream.reasoning_effort).toBe('high');
    expect(upstream.thinking).toBeUndefined();
  });

  it('sends nothing for a model that cannot reason', async () => {
    const upstream = await buildUpstreamBody(
      { ...chatBody, model: 'glm-5.3-lite', reasoning_effort: 'high' },
      makeContext(glmCatalog),
    );

    expect(upstream.reasoning_effort).toBeUndefined();
    expect(upstream.thinking).toBeUndefined();
  });

  it('snaps a Responses effort onto the level the model advertises', async () => {
    const upstream = await normalizeResponsesUpstreamBody(
      {
        input: [{ content: 'hello', role: 'user' }],
        model: 'glm-5.3',
        reasoning: { effort: 'xhigh', summary: 'auto' },
      },
      glmCatalog,
    );

    expect(upstream.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('leaves a Responses request for an unknown model alone', async () => {
    const upstream = await normalizeResponsesUpstreamBody(
      {
        input: [{ content: 'hello', role: 'user' }],
        model: 'unknown',
        reasoning: { effort: 'xhigh' },
      },
      glmCatalog,
    );

    expect(upstream.reasoning).toEqual({ effort: 'xhigh' });
  });
});
