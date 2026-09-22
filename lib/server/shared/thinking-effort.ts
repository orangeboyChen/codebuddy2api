import {
  type CredentialData,
  getCredentialSupportedModelDetails,
} from '../domain/credentials';

/**
 * Thinking resolution for every client vocabulary.
 *
 * Claude Code sends Anthropic `thinking: { type, budget_tokens }`, Codex sends
 * Responses `reasoning: { effort }`, and Chat clients send `reasoning_effort`.
 * None of those reaches the upstream intact: it takes a single effort value,
 * and the `/v3/config` catalog reports which ones each model accepts as
 * `reasoning.supportedEfforts`.
 *
 * So a request is read onto one ladder and then sent in one of two ways:
 *
 * - A model that advertises its efforts gets the nearest one, in its own
 *   spelling — a level it does not offer is rejected or ignored upstream.
 * - A model the catalog does not describe gets the ladder level mapped onto the
 *   vocabulary the upstream uses for its own models.
 *
 * Either way the Anthropic `thinking` block is dropped once it has been read:
 * leaving it beside the effort would ask for the same thing twice, in two
 * vocabularies, and the block itself is not a shape the upstream accepts.
 */

/**
 * The ladder every vocabulary is read onto, from no thinking to the deepest.
 *
 * `no_think` is a spelling a client may use for "off" and `max` is a synonym
 * for the deepest level, so both sit on an existing rung rather than extending
 * the ladder with a level nothing accepts.
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
 * The effort sent for a model the catalog does not describe.
 *
 * These are the values the upstream uses for its own models: `low`, `medium`
 * and `high` as the effort it applies by default, and `max` on the models that
 * advertise a list. Anything off that vocabulary is mapped onto it rather than
 * forwarded, because an effort upstream does not know is ignored and the caller
 * silently gets the default instead of the depth it asked for.
 *
 * `xhigh` becomes `high` and the thinking-off levels become `low`: the upstream
 * models that advertise efforts all declare `canDisableThinking: false`, so
 * there is no way to ask for less thinking than `low`.
 */
const UPSTREAM_EFFORT_BY_LEVEL: Record<string, string> = {
  high: 'high',
  low: 'low',
  max: 'max',
  medium: 'medium',
  minimal: 'low',
  no_think: 'low',
  none: 'low',
  off: 'low',
  xhigh: 'high',
};

/**
 * Anthropic `budget_tokens` is a raw token budget, not a level, so it is
 * bucketed against the output sizes the levels correspond to. The cut points
 * match the ones the Chat → Responses translator uses, so a client that reaches
 * the upstream over either protocol lands on the same level.
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
 * The effort to send for a model the catalog does not describe.
 *
 * Yields `undefined` for a level this ladder does not know, so a request in a
 * vocabulary the proxy cannot read is forwarded as it arrived rather than being
 * rewritten onto a level picked at random.
 */
export const toUpstreamEffort = (level: unknown): string | undefined => {
  const normalized = normalizeEffort(level);

  if (!normalized) return undefined;

  const effort = UPSTREAM_EFFORT_BY_LEVEL[normalized];

  return typeof effort === 'string' ? effort : undefined;
};

/**
 * Snaps a requested level onto the nearest one the model advertises.
 *
 * An exact match is returned in the model's own spelling. Otherwise the closest
 * rung wins, and a tie goes to the deeper level: the caller asked for thinking,
 * and the shallower neighbour would silently under-deliver it. A level this
 * ladder does not know yields `undefined`, so the caller falls back to the
 * upstream vocabulary instead of guessing at its depth.
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
 * The requested level is the chat effort when the client sent one, and other-
 * wise the level its Anthropic `thinking` block asks for. A model upstream
 * describes as unable to reason gets both fields dropped, since forwarding
 * either would ask for reasoning it cannot do.
 */
export const resolveChatThinking = (
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

  if (capabilities?.supportsReasoning === false) {
    return { reasoningEffort: undefined, thinking: undefined };
  }

  const requested =
    normalizeEffort(body.reasoning_effort) ??
    anthropicThinkingToEffort(body.thinking);

  if (!requested) return fallback;

  const effort =
    pickSupportedEffort(requested, capabilities?.supportedEfforts) ??
    toUpstreamEffort(requested);

  return effort ? { reasoningEffort: effort, thinking: undefined } : fallback;
};

/**
 * Resolves the `reasoning` object to send upstream for a Responses request.
 *
 * A model upstream describes as unable to reason gets the whole object dropped,
 * matching the Chat path: keeping a `summary` would still ask for reasoning the
 * model does not do.
 */
export const resolveResponsesReasoning = (
  credentialData: CredentialData | null | undefined,
  model: string | undefined,
  reasoning: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!reasoning || typeof reasoning !== 'object') return reasoning;

  const capabilities = findModelThinkingCapabilities(credentialData, model);

  if (capabilities?.supportsReasoning === false) return undefined;

  const requested = normalizeEffort(reasoning.effort);

  if (!requested) return reasoning;

  const effort =
    pickSupportedEffort(requested, capabilities?.supportedEfforts) ??
    toUpstreamEffort(requested);

  return effort ? { ...reasoning, effort } : reasoning;
};
