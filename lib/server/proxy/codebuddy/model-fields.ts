import type { DiscoveredModel } from './types';

/**
 * Upstream descriptions are prose meant for a tooltip; the card renders a line
 * of them, so anything past this is dead weight in the cached catalog.
 */
export const MODEL_DESCRIPTION_MAX_LENGTH = 512;

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

const asDescription = (value: unknown): string | undefined => {
  const text = asTrimmedString(value);

  return text && text.length > MODEL_DESCRIPTION_MAX_LENGTH
    ? text.slice(0, MODEL_DESCRIPTION_MAX_LENGTH)
    : text;
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

  return {
    contextWindow: asFiniteNumber(entry.contextWindow),
    credits: asTrimmedString(entry.credits),
    descriptionEn: asDescription(entry.descriptionEn),
    descriptionZh: asDescription(entry.descriptionZh),
    displayName: asTrimmedString(entry.displayName) ?? id,
    id,
    isEnterprise: asBoolean(entry.isEnterprise),
    isFree: asBoolean(entry.isFree),
    isInternal: asBoolean(entry.isInternal),
    maxInputTokens: asFiniteNumber(entry.maxInputTokens),
    maxOutputTokens: asFiniteNumber(entry.maxOutputTokens),
    supportsImages: asBoolean(entry.supportsImages),
    supportsReasoning: asBoolean(entry.supportsReasoning),
    supportsToolCall: asBoolean(entry.supportsToolCall),
    vendor: asTrimmedString(entry.vendor),
  };
};
