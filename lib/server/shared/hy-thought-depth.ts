import { getHyThoughtDepthEnabled, isHyModel } from '../domain/config';

/**
 * Hy-series models (hy3 and friends) take their thinking depth as
 * `reasoning_effort`, whose only accepted values are `no_think`, `low` and
 * `high`. No downstream client speaks that vocabulary:
 *
 * - Claude Code sends Anthropic `thinking: {type, budget_tokens}`.
 * - Codex sends Responses `reasoning: {effort}`, where `effort` is one of
 *   `minimal`/`low`/`medium`/`high`/`xhigh`/`max`.
 * - Plain Chat clients send `reasoning_effort` in the OpenAI vocabulary.
 *
 * Forwarding any of those verbatim makes the upstream reject the request or
 * silently ignore the intent, so each is converted onto the Hy vocabulary here.
 * The mapping is fixed by the upstream contract rather than by configuration:
 * the console switch only decides whether conversion happens at all.
 */

export const HY_EFFORT_NO_THINK = 'no_think';
export const HY_EFFORT_LOW = 'low';
export const HY_EFFORT_HIGH = 'high';

/**
 * Anthropic has no notion of "no thinking" other than omitting the block, and
 * its `budget_tokens` is a token count rather than a named level. The 1_024
 * threshold is the Anthropic minimum for enabling thinking at all, so anything
 * below it means the caller effectively asked for no thinking.
 */
const ANTHROPIC_MIN_THINKING_BUDGET = 1_024;

/**
 * OpenAI's `reasoning_effort` vocabulary is finer-grained than Hy's three
 * levels, so neighbouring values collapse onto the closest Hy level instead of
 * being dropped.
 */
const OPENAI_EFFORT_TO_HY: Record<string, string> = {
  high: HY_EFFORT_HIGH,
  low: HY_EFFORT_LOW,
  max: HY_EFFORT_HIGH,
  medium: HY_EFFORT_LOW,
  minimal: HY_EFFORT_NO_THINK,
  none: HY_EFFORT_NO_THINK,
  xhigh: HY_EFFORT_HIGH,
};

/**
 * Anthropic `budget_tokens` is a raw token budget, not a level, so it is bucketed
 * against the output sizes the Hy levels correspond to: `no_think` caps out at
 * 8K, `low` is recommended around 16K and `high` reaches 64K. The upstream fixes
 * the sizes but not the reverse mapping, so the cut points are ours: at or below
 * 8K the request still fits `low`'s recommended envelope, above it only `high`
 * can produce the output that was asked for.
 *
 * Below the Anthropic minimum for enabling thinking at all there is effectively
 * no thinking to pay for, so it resolves to `no_think`.
 */
const anthropicBudgetToHyEffort = (budgetTokens: number): string => {
  if (
    !Number.isFinite(budgetTokens) ||
    budgetTokens < ANTHROPIC_MIN_THINKING_BUDGET
  ) {
    return HY_EFFORT_NO_THINK;
  }

  return budgetTokens <= 8_192 ? HY_EFFORT_LOW : HY_EFFORT_HIGH;
};

const normalizeEffort = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();

  return normalized || undefined;
};

/**
 * Converts Anthropic `thinking` into the Hy `reasoning_effort` value it
 * expresses. `type: 'disabled'` is the explicit "no thinking" case; otherwise
 * the token budget decides the level, and a missing budget still means the
 * caller asked for thinking, so it resolves to `high` rather than to nothing.
 */
export const anthropicThinkingToHyEffort = (
  thinking: { budget_tokens?: number; type?: string } | undefined,
): string | undefined => {
  if (!thinking || typeof thinking !== 'object') return undefined;

  const type = normalizeEffort(thinking.type);

  if (type === 'disabled' || type === 'none') return HY_EFFORT_NO_THINK;
  if (type !== 'enabled' && type !== 'adaptive') return undefined;

  const budgetTokens =
    typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : Number.NaN;

  return Number.isFinite(budgetTokens)
    ? anthropicBudgetToHyEffort(budgetTokens)
    : HY_EFFORT_HIGH;
};

/**
 * Converts an effort level from either the OpenAI or the Responses vocabulary
 * into the Hy one. Unknown levels yield `undefined` so the caller can leave the
 * field out rather than send something the upstream would reject.
 */
export const openaiEffortToHyEffort = (effort: unknown): string | undefined => {
  const normalized = normalizeEffort(effort);

  return normalized ? OPENAI_EFFORT_TO_HY[normalized] : undefined;
};

/**
 * Resolves the thinking fields to send upstream for a Chat request.
 *
 * The client's own `reasoning_effort` wins when it is already a Hy value, since
 * that needs no conversion. Anthropic `thinking` is only consulted for Hy models
 * because it is a different protocol's field, and applying it to a non-Hy model
 * would change behaviour for upstreams that already understand it.
 *
 * `thinking` is reported separately so the caller can drop it once it has been
 * translated: leaving the original Anthropic block in place alongside the
 * converted `reasoning_effort` would still be rejected by the very upstream this
 * translation exists to satisfy, and it would also ask twice, in two different
 * vocabularies, for the same thing.
 */
export const resolveHyChatThinking = async (
  model: string | undefined,
  body: {
    reasoning_effort?: string;
    thinking?: { budget_tokens?: number; type?: string };
  },
): Promise<{
  reasoningEffort: string | undefined;
  thinking: { budget_tokens?: number; type?: string } | undefined;
}> => {
  const fallback = {
    reasoningEffort: body.reasoning_effort,
    thinking: body.thinking,
  };

  if (!(await getHyThoughtDepthEnabled())) return fallback;
  if (!isHyModel(model)) return fallback;

  const clientEffort = normalizeEffort(body.reasoning_effort);

  if (
    clientEffort === HY_EFFORT_NO_THINK ||
    clientEffort === HY_EFFORT_LOW ||
    clientEffort === HY_EFFORT_HIGH
  ) {
    return { reasoningEffort: clientEffort, thinking: undefined };
  }

  const fromClientEffort = openaiEffortToHyEffort(body.reasoning_effort);

  if (fromClientEffort) {
    return { reasoningEffort: fromClientEffort, thinking: undefined };
  }

  const fromThinking = anthropicThinkingToHyEffort(body.thinking);

  // Only drop `thinking` when it actually produced a value; an unrecognized
  // shape is left alone so the request is forwarded exactly as it arrived.
  return fromThinking
    ? { reasoningEffort: fromThinking, thinking: undefined }
    : fallback;
};

/**
 * Resolves the `reasoning` object to send upstream for a Responses request,
 * converting a non-Hy effort level onto the Hy vocabulary.
 */
export const resolveHyResponsesReasoning = async (
  model: string | undefined,
  reasoning: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> => {
  if (!(await getHyThoughtDepthEnabled())) return reasoning;
  if (!isHyModel(model)) return reasoning;
  if (!reasoning || typeof reasoning !== 'object') return reasoning;

  const effort = normalizeEffort(reasoning.effort);

  if (!effort) return reasoning;

  const converted = openaiEffortToHyEffort(effort);

  return converted ? { ...reasoning, effort: converted } : reasoning;
};
