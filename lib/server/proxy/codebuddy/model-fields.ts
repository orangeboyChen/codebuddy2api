import type {
  DiscoveredModel,
  DiscoveredModelPromotion,
  DiscoveredModelTier,
} from './types';

/**
 * Upstream descriptions are prose meant for a tooltip; the card renders a line
 * of them, so anything past this is dead weight in the cached catalog.
 */
export const MODEL_DESCRIPTION_MAX_LENGTH = 512;

/**
 * Cap on the list-valued fields — capability tags, context lengths, thinking
 * efforts, variants.
 *
 * The catalog is cached per credential, so an unbounded list is a credential
 * file that grows without limit; a model advertising hundreds of variants is
 * upstream being verbose, not the console being asked to print them all.
 */
const MAX_LIST_LENGTH = 8;

/** Cap on a single short string, such as a tag or a thinking effort. */
const MAX_SHORT_STRING_LENGTH = 64;

/**
 * Cap on a model id, which runs longer than a tag: upstream ids reach dozens
 * of characters, and a variant id has to survive being cached.
 */
const MAX_ID_LENGTH = 128;

/** Cap on the operator copy a promotion carries. */
const MAX_PROMOTION_TEXT_LENGTH = 256;

const asTrimmedString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Reads a numeric limit such as a context or output window.
 *
 * `Number(true)` is 1 and `Number([])` is 0, so the type is checked before the
 * value is coerced: a boolean or an object is upstream saying nothing at all,
 * and reading it as a limit would invent one. Non-positive numbers are unknown
 * too, because upstream never advertises a zero-token window.
 */
const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  const number = trimmed ? Number(trimmed) : Number.NaN;

  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Reads a list of short strings, dropping the empty and the oversized. */
const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const list: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') continue;

    const trimmed = item.trim();

    if (
      !trimmed ||
      trimmed.length > MAX_SHORT_STRING_LENGTH ||
      list.includes(trimmed)
    ) {
      continue;
    }

    list.push(trimmed);

    if (list.length >= MAX_LIST_LENGTH) break;
  }

  return list.length ? list : undefined;
};

/** Reads a list of positive limits, such as the context lengths on offer. */
const asNumberList = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const list: number[] = [];

  for (const item of value) {
    const number = asFiniteNumber(item);

    if (number === undefined || list.includes(number)) continue;

    list.push(number);

    if (list.length >= MAX_LIST_LENGTH) break;
  }

  return list.length ? list : undefined;
};

/**
 * Reads the variant map: variant name to model id.
 *
 * Keys and values are both capped, and a duplicate variant keeps its first id,
 * because the map is printed as-is and a second entry for `lite` would be two
 * answers to the same question.
 */
const asStringMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const map: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue;

    // Trimmed before the duplicate test: `lite` and `lite ` are one variant and
    // the first one wins. `hasOwn` rather than `in`, so a variant named after
    // an Object prototype member is not silently dropped.
    const name = key.trim();
    const id = entry.trim();

    if (
      !name ||
      !id ||
      Object.hasOwn(map, name) ||
      name.length > MAX_SHORT_STRING_LENGTH ||
      id.length > MAX_ID_LENGTH
    ) {
      continue;
    }

    map[name] = id;

    if (Object.keys(map).length >= MAX_LIST_LENGTH) break;
  }

  return Object.keys(map).length ? map : undefined;
};

const asPromotion =
  (now: number) =>
  (value: unknown): DiscoveredModelPromotion | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const entry = value as Record<string, unknown>;
    const endsAt = asTimestamp(entry.endsAt);
    const startsAt = asTimestamp(entry.startsAt);

    // A promotion is a window, and the catalog is cached — so the window is
    // re-read every time the model is normalized: an offer that has ended, or
    // has not begun, stops being quoted instead of being shown forever.
    if (endsAt !== undefined && Date.parse(endsAt) <= now) return undefined;
    if (startsAt !== undefined && Date.parse(startsAt) > now) return undefined;

    const promotion = {
      discountedCredits: asShortString(entry.discountedCredits),
      endsAt,
      label: asShortString(entry.label),
      startsAt,
      textEn: asProse(MAX_PROMOTION_TEXT_LENGTH)(entry.textEn),
      textZh: asProse(MAX_PROMOTION_TEXT_LENGTH)(entry.textZh),
    };

    return Object.values(promotion).some((field) => field !== undefined)
      ? promotion
      : undefined;
  };

const asTier = (value: unknown): DiscoveredModelTier | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entry = value as Record<string, unknown>;
  const tier = {
    label: asShortString(entry.label),
    level: asShortString(entry.level),
  };

  return Object.values(tier).some((field) => field !== undefined)
    ? tier
    : undefined;
};

/**
 * Reads prose that is rendered verbatim, trimmed to a sane length.
 *
 * The slice walks code points, not UTF-16 units: cutting a description inside
 * a surrogate pair would leave a broken glyph on the card.
 */
const asProse =
  (maxLength: number) =>
  (value: unknown): string | undefined => {
    const text = asTrimmedString(value);

    if (!text) return undefined;

    return [...text].length > maxLength
      ? [...text].slice(0, maxLength).join('')
      : text;
  };

const asDescription = asProse(MODEL_DESCRIPTION_MAX_LENGTH);

const asShortString = asProse(MAX_SHORT_STRING_LENGTH);

/**
 * A timestamp the console can print as a day: an ISO calendar date, or a
 * date-time carrying its own offset.
 *
 * Anything else is dropped. A date-time with no offset would be read in
 * whichever zone this process sits in, which moves the printed day by one for
 * much of the world; an `Invalid Date` beside a promotion would read as a fact
 * about the offer.
 */
const PRINTABLE_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

const asTimestamp = (value: unknown): string | undefined => {
  const text = asTrimmedString(value);

  if (!text || !PRINTABLE_TIMESTAMP.test(text)) return undefined;

  const parsed = Date.parse(text.replace(' ', 'T'));

  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

/**
 * Rebuilds a `DiscoveredModel` from untrusted input — an upstream payload, or
 * the cached catalog an older version or a human wrote.
 *
 * Only declared fields survive, so an unexpected key can never reach the
 * console, and a field of the wrong type degrades to "absent" instead of being
 * rendered as-is. `displayName` falls back to the id because both the row and
 * the copy control print it.
 */
export const normalizeModelFields = (
  entry: Record<string, unknown>,
): DiscoveredModel | undefined => {
  const id = asTrimmedString(entry.id);

  if (!id) return undefined;

  const now = Date.now();

  return {
    capabilityTags: asStringList(entry.capabilityTags),
    contextLengths: asNumberList(entry.contextLengths),
    contextWindow: asFiniteNumber(entry.contextWindow),
    credits: asShortString(entry.credits),
    defaultEffort: asShortString(entry.defaultEffort),
    descriptionEn: asDescription(entry.descriptionEn),
    descriptionZh: asDescription(entry.descriptionZh),
    // Printed on the card, so an absurd value is capped rather than cached and
    // rendered as-is. The id itself is left alone: routing matches on it
    // verbatim.
    displayName: asProse(MAX_ID_LENGTH)(entry.displayName) ?? id,
    id,
    isDefault: asBoolean(entry.isDefault),
    isEnterprise: asBoolean(entry.isEnterprise),
    isFree: asBoolean(entry.isFree),
    isInternal: asBoolean(entry.isInternal),
    maxAllowedSize: asFiniteNumber(entry.maxAllowedSize),
    maxInputTokens: asFiniteNumber(entry.maxInputTokens),
    maxOutputTokens: asFiniteNumber(entry.maxOutputTokens),
    onlyReasoning: asBoolean(entry.onlyReasoning),
    promotion: asPromotion(now)(entry.promotion),
    relatedModels: asStringMap(entry.relatedModels),
    supportedEfforts: asStringList(entry.supportedEfforts),
    supportsImages: asBoolean(entry.supportsImages),
    supportsReasoning: asBoolean(entry.supportsReasoning),
    supportsToolCall: asBoolean(entry.supportsToolCall),
    tier: asTier(entry.tier),
    vendor: asShortString(entry.vendor),
  };
};
