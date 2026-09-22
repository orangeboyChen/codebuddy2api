import {
  type CredentialData,
  getCredentialSupportedModelDetails,
} from '../domain/credentials';

/**
 * Model-aware thinking resolution.
 *
 * Every client asks for a thinking depth in its own vocabulary:
 *
 * - Claude Code sends Anthropic `thinking: { type, budget_tokens }`.
 * - Codex sends Responses `reasoning: { effort }`, where `effort` is one of
 *   `minimal`/`low`/`medium`/`high`/`xhigh`.
 * - Plain Chat clients send `reasoning_effort` in the OpenAI vocabulary.
 * - Hy-series models answer to `no_think`/`low`/`high` instead.
 *
 * The upstream catalog (`/v3/config`) reports the efforts each model actually
 * accepts as `reasoning.supportedEfforts`. Forwarding a level the model does
 * not offer makes the upstream reject the request or silently ignore the
 * intent, so the requested level is read onto one ladder and then snapped onto
 * the nearest level the model advertises. The value sent is always one of the
 * model's own strings, never a spelling invented here.
 *
 * Anything the catalog does not describe is forwarded untouched: an unknown
 * model, or one that advertises no efforts, is a gap in what upstream told us
 * rather than a licence to rewrite the request.
 */

/**
 * The ladder every vocabulary is read onto, from no thinking to the deepest.
 *
 * `no_think` is the Hy spelling of `off` and `max` is a synonym clients use for
 * the deepest level, so both sit on an existing rung rather than extending the
 * ladder with a level no upstream accepts.
 */
const EFFORT_RANKS: Record<string, number> = {
  max: 5,
  medium: 3,
  minimal: 1,
  no_think: 0,
  none: 0,
  off: 0,
  high: 4,
  low: 2,
  xhigh: 5,
};

/**
 * Anthropic `budget_tokens` is a raw token budget, not a level, so it is
 * bucketed against the output sizes the levels correspond to. The cut points
 * match the ones the Chat → Responses translator already uses, so a client that
 * reaches the upstream over either protocol lands on the same level.
 */
const MINIMAL_THINKING_BUDGET = 2_048;
const MEDIUM_THINKING_BUDGET = 8_192;

/** The level a caller gets when it asks for thinking without naming a budget. */
const DEFAULT_THINKING_EFFORT = 'high';

export interface ModelThinkingCapabilities {
  /** Whether upstream serves the model with reasoning at all. */
  supportsReasoning?: boolean;
  /** The thinking efforts upstream lets a caller pick from. */
  supportedEfforts?: string[];
}

const normalizeEffort = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();

  return normalized || undefined;
};

/**
 * Reads a level onto the ladder.
 *
 * A non-numeric lookup — `EFFORT_RANKS['constructor']`, say — is not a rank, so
 * an effort named after an `Object` prototype member is treated as unknown
 * rather than as a level.
 */
const effortRank = (effort: string): number | undefined => {
  const rank = EFFORT_RANKS[effort];

  return typeof rank === 'number' ? rank : undefined;
};

/**
 * Reads an Anthropic `thinking` block onto the ladder.
 *
 * `type: 'disabled'` is the explicit "no thinking" case; otherwise the token
 * budget decides the level, and a block asking for thinking without naming a
 * budget is read as the deepest level, because the caller asked for thinking
 * and said nothing that would limit it. A shape that is not a thinking request
 * at all yields `undefined` so the caller can leave the request alone.
 */
export const anthropicThinkingToEffort = (
  thinking: { budget_tokens?: number; type?: string } | undefined,
): string | undefined => {
  if (!thinking || typeof thinking !== 'object') return undefined;

  const type = normalizeEffort(thinking.type);

  if (type === 'disabled' || type === 'none' || type === 'off') return 'off';
  if (type !== 'enabled' && type !== 'adaptive') return undefined;

  const budgetTokens =
    typeof thinking.budget_tokens === 'number'
      ? thinking.budget_tokens
      : Number.NaN;

  if (!Number.isFinite(budgetTokens)) return DEFAULT_THINKING_EFFORT;

  if (budgetTokens <= MINIMAL_THINKING_BUDGET) return 'minimal';

  return budgetTokens <= MEDIUM_THINKING_BUDGET
    ? 'medium'
    : DEFAULT_THINKING_EFFORT;
};

/**
 * Snaps a requested level onto the nearest one the model advertises.
 *
 * An exact match is returned in the model's own spelling. Otherwise the closest
 * rung wins, and a tie goes to the deeper level: the caller asked for thinking,
 * and the shallower neighbour would silently under-deliver it. A level this
 * ladder does not know is left to the caller — guessing at its depth would move
 * a request the proxy cannot read onto a level the model may not accept.
 */
export const pickSupportedEffort = (
  requested: unknown,
  supported: string[] | undefined,
): string | undefined => {
  const normalized = normalizeEffort(requested);

  if (!normalized || !supported?.length) return undefined;

  // Keyed by the normalized level so a catalog that capitalizes differently
  // still matches, while the value keeps the spelling upstream expects.
  const byLevel = new Map<string, string>();

  for (const effort of supported) {
    const level = normalizeEffort(effort);

    if (level && !byLevel.has(level)) byLevel.set(level, effort);
  }

  if (!byLevel.size) return undefined;

  const exact = byLevel.get(normalized);

  if (exact) return exact;

  const requestedRank = effortRank(normalized);

  if (requestedRank === undefined) return undefined;

  let closest: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  let closestRank = Number.NEGATIVE_INFINITY;

  for (const [level, effort] of byLevel) {
    const rank = effortRank(level);

    if (rank === undefined) continue;

    const distance = Math.abs(rank - requestedRank);

    // A tie goes to the deeper level, so the comparison has to be against the
    // rank of the level already chosen and not only against its distance.
    if (distance > closestDistance) continue;
    if (distance === closestDistance && rank <= closestRank) continue;

    closest = effort;
    closestDistance = distance;
    closestRank = rank;
  }

  return closest;
};

/**
 * Reads what upstream said about a model's thinking.
 *
 * Returns `undefined` when the model is not in the cached catalog, whether
 * because discovery has not run for this credential or because the model is not
 * one upstream offers it.
 */
export const findModelThinkingCapabilities = (
  credentialData: CredentialData | null | undefined,
  model: string | undefined,
): ModelThinkingCapabilities | undefined => {
  const id = typeof model === 'string' ? model.trim() : '';

  if (!id) return undefined;

  const entry = getCredentialSupportedModelDetails(credentialData).find(
    (candidate) => candidate.id === id,
  );

  if (!entry) return undefined;

  return {
    supportsReasoning: entry.supportsReasoning,
    supportedEfforts: entry.supportedEfforts,
  };
};

/**
 * Resolves the thinking fields to send upstream for a Chat request.
 *
 * A model upstream describes as unable to reason at all gets both fields
 * dropped: forwarding either would send a shape the upstream rejects or
 * ignores. Otherwise the requested level — the chat effort when the client sent
 * one, else the level its Anthropic `thinking` block asks for — is snapped onto
 * the model's advertised efforts and returned as `reasoning_effort`.
 *
 * `thinking` is dropped once it has been translated, for the same reason the Hy
 * conversion drops it: leaving the Anthropic block beside the converted effort
 * would ask twice, in two vocabularies, for the same thing.
 */
export const resolveModelChatThinking = (
  credentialData: CredentialData | null | undefined,
  model: string | undefined,
  body: {
    reasoning_effort?: string;
    thinking?: { budget_tokens?: number; type?: string };
  },
): {
  reasoningEffort: string | undefined;
  thinking: { budget_tokens?: number; type?: string } | undefined;
} => {
  const fallback = {
    reasoningEffort: body.reasoning_effort,
    thinking: body.thinking,
  };
  const capabilities = findModelThinkingCapabilities(credentialData, model);

  if (!capabilities) return fallback;

  if (capabilities.supportsReasoning === false) {
    return { reasoningEffort: undefined, thinking: undefined };
  }

  const requested =
    normalizeEffort(body.reasoning_effort) ??
    anthropicThinkingToEffort(body.thinking);

  if (!requested) return fallback;

  const effort = pickSupportedEffort(requested, capabilities.supportedEfforts);

  return effort ? { reasoningEffort: effort, thinking: undefined } : fallback;
};

/**
 * Resolves the `reasoning` object to send upstream for a Responses request,
 * snapping the requested effort onto the level the model advertises.
 *
 * A model upstream describes as unable to reason gets the whole object dropped,
 * matching the Chat path: keeping a `summary` would still ask for reasoning the
 * model does not do.
 */
export const resolveModelResponsesReasoning = (
  credentialData: CredentialData | null | undefined,
  model: string | undefined,
  reasoning: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!reasoning || typeof reasoning !== 'object') return reasoning;

  const capabilities = findModelThinkingCapabilities(credentialData, model);

  if (!capabilities) return reasoning;

  // Every field of a `reasoning` object is a request for reasoning — `summary`
  // asks the upstream to summarize thinking it is not going to do — so the whole
  // object goes rather than just the effort.
  if (capabilities.supportsReasoning === false) return undefined;

  const effort = pickSupportedEffort(
    reasoning.effort,
    capabilities.supportedEfforts,
  );

  return effort ? { ...reasoning, effort } : reasoning;
};
