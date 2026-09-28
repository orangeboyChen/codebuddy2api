import { ADMIN_SESSION_COOKIE } from '../admin/cookie';

/**
 * Today's token counts, as the menu bar item shows them: what went in and what
 * came back out.
 */
export interface DesktopUsage {
  input: number;
  output: number;
}

/** Long enough for a slow local query, short enough not to hold a timer open. */
const USAGE_TIMEOUT_MS = 5_000;

const toCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

/**
 * Reads today's input and output tokens out of an `/admin-api/usage` payload.
 *
 * The rows are the only place the split exists: the summary the response also
 * carries counts a single `totalTokens`, and the menu bar item promises two
 * numbers. Nothing is inferred from the total, so a payload that changes shape
 * is reported as unavailable rather than as a wrong count.
 */
export const usageFromAnalytics = (payload: unknown): DesktopUsage | null => {
  const rows =
    payload && typeof payload === 'object'
      ? (payload as { tableRows?: unknown }).tableRows
      : null;

  if (!Array.isArray(rows)) {
    return null;
  }

  let input = 0;
  let output = 0;

  for (const row of rows) {
    const record =
      row && typeof row === 'object'
        ? (row as { inputTokens?: unknown; outputTokens?: unknown })
        : null;

    input += toCount(record?.inputTokens);
    output += toCount(record?.outputTokens);
  }

  return { input, output };
};

/**
 * Asks whichever backend is in use for today's usage.
 *
 * A failure of any kind — an unreachable gateway, a remote deployment that
 * wants a sign-in the shell has no cookie for — is answered with `null`, which
 * the menu bar renders as unavailable. It is a status display: it must never
 * rethrow into a timer and never keep a stale number on screen.
 */
export const fetchTodayUsage = async ({
  baseUrl,
  cookie = '',
  signal = AbortSignal.timeout(USAGE_TIMEOUT_MS),
}: {
  baseUrl: string;
  cookie?: string;
  signal?: AbortSignal;
}): Promise<DesktopUsage | null> => {
  try {
    const response = await fetch(`${baseUrl}/admin-api/usage?range=today`, {
      headers: cookie ? { cookie } : {},
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return usageFromAnalytics(await response.json());
  } catch {
    return null;
  }
};

/**
 * The cookie header for a request the shell makes on the console's behalf.
 *
 * A remote deployment guards its admin API with the same session cookie the
 * console uses, and the shell has no credentials of its own — it only borrows
 * the one the window already has, after the user signed in there.
 */
export const adminCookieHeader = (
  cookies: Array<{ name: string; value: string }>,
): string =>
  cookies
    .filter((it) => it.name === ADMIN_SESSION_COOKIE && it.value)
    .map((it) => `${it.name}=${it.value}`)
    .join('; ');
