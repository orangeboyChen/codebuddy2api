/**
 * Small coercion helpers shared across the proxy and domain layers.
 *
 * Both functions here were declared independently in several modules before
 * being lifted out. Guarding with `!Array.isArray` matters: an array is an
 * object, so a bare `typeof value === 'object'` test lets arrays through as
 * records, which is almost never what the caller meant.
 */

/** Narrows an unknown value to a plain object, rejecting arrays and null. */
export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Flattens message content into a single string.
 *
 * Content arrives as a bare string, an array of parts, or something else
 * entirely depending on which protocol produced it. Parts carrying a `text`
 * field contribute that text; anything else falls back to its JSON form so an
 * unexpected part still shows up rather than vanishing.
 */
export const stringifyContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }

        return JSON.stringify(item);
      })
      .join('');
  }

  return JSON.stringify(value);
};

/**
 * Reads the reasoning a message carries, accepting either spelling.
 *
 * Upstreams emit `reasoning_content` (the streaming/response field) or
 * `reasoning` (the field we replay prior-turn reasoning on), so both are
 * recognised with `reasoning_content` taking precedence.
 */
export const readReasoning = (
  message: { reasoning?: unknown; reasoning_content?: unknown } | undefined,
): string => {
  if (!message) {
    return '';
  }

  const { reasoning, reasoning_content: reasoningContent } = message;

  return typeof reasoningContent === 'string'
    ? reasoningContent
    : typeof reasoning === 'string'
      ? reasoning
      : '';
};
