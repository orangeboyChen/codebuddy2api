/**
 * Pure accessors for per-account automatic check-in settings.
 *
 * Kept separate from `auto-checkin.ts` (which writes, and so imports the
 * credential store) so that `credentials.ts` can read these without closing an
 * import cycle.
 */

/**
 * The subset of a credential these helpers need.
 *
 * Structural rather than importing `CredentialData`, because `credentials.ts`
 * uses these helpers — a named import here would close a cycle that runs at
 * module-init time.
 */
interface AutoCheckinCredentialLike {
  /**
   * `unknown` rather than `boolean` because a hand-edited credential file can
   * hold `"true"`, and the rest of the codebase accepts that form too.
   */
  auto_checkin_enabled?: boolean | string | unknown;
  auto_checkin_time?: string;
}

export const AUTO_CHECKIN_MINUTE_OPTIONS = [0, 30] as const;

export const DEFAULT_AUTO_CHECKIN_TIME = '09:00';

/**
 * Matches a 24-hour `HH:MM` time.
 *
 * Deliberately strict: a bad time would either never fire or fire at an
 * unexpected hour, and both are worse than rejecting the input.
 */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isValidAutoCheckinTime = (value: unknown): boolean =>
  typeof value === 'string' && TIME_PATTERN.test(value.trim());

/**
 * Reads the time, falling back to the default when unset or malformed.
 *
 * Malformed values can only come from a hand-edited credential file or an older
 * release; falling back keeps the scheduler running instead of silently
 * skipping the account forever.
 */
export const getAutoCheckinTime = (data: AutoCheckinCredentialLike): string => {
  const value = data.auto_checkin_time;

  return typeof value === 'string' && isValidAutoCheckinTime(value)
    ? value.trim()
    : DEFAULT_AUTO_CHECKIN_TIME;
};

const getBoolean = (value: unknown): boolean =>
  typeof value === 'boolean'
    ? value
    : typeof value === 'string'
      ? value.trim().toLowerCase() === 'true'
      : false;

export const isAutoCheckinEnabled = (
  data: AutoCheckinCredentialLike,
): boolean => getBoolean(data.auto_checkin_enabled);

export const getAutoCheckinSettings = (
  data: AutoCheckinCredentialLike,
): { enabled: boolean; time: string } => ({
  enabled: isAutoCheckinEnabled(data),
  time: getAutoCheckinTime(data),
});
