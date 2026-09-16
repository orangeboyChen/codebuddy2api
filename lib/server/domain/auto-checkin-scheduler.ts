/**
 * Scheduler for per-account automatic check-in.
 *
 * The gateway is a request-driven Next.js app with no queue or cron, so this
 * runs a single interval inside the Node process and is started from
 * `instrumentation.ts`. That makes it deliberately best-effort:
 *
 * - It only fires while the process is up. A deployment that scales to zero
 *   between requests will miss its slot, and the check-in simply happens on the
 *   next tick instead.
 * - It runs at most once per account per local day, recorded on the credential,
 *   so a restart cannot double-claim and a missed slot is caught by the next
 *   tick rather than being skipped until tomorrow.
 * - It is concurrency-safe in the coarse sense that matters here: two instances
 *   racing will each see the recorded date before claiming, and the upstream
 *   treats a repeat claim as already-claimed rather than as an error.
 *
 * Accounts that are already checked in are skipped, and every failure is logged
 * rather than thrown — a broken schedule must never take the process down.
 */

import { checkinAccount, getAccountStatus } from './account-status';
import { recordAutoCheckinRun } from './auto-checkin';
import { getAutoCheckinSettings } from './auto-checkin-settings';
import { listEligibleCredentialRecords } from './credentials';

/** How often to look for a due slot. Half an hour matches the offered times. */
const TICK_INTERVAL_MS = 30 * 60 * 1000;
/** Delay before the first tick, so storage is ready after startup. */
const START_DELAY_MS = 10 * 1000;
/** Cap per tick so a large deployment does not burst on startup. */
const MAX_PER_TICK = 4;

const globalSchedulerState = globalThis as typeof globalThis & {
  __codebuddy2apiAutoCheckin__?: {
    timer: ReturnType<typeof setInterval>;
    ticking: boolean;
  };
};

/** Local `YYYY-MM-DD`, used to remember that today's slot was taken. */
export const localDateKey = (now: Date): string => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

/** Local `HH:MM` in 24-hour form, to compare against the configured time. */
export const localTimeKey = (now: Date): string => {
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
};

/**
 * Whether `time` (a slot like `09:00`, or `09:30`) has arrived by `now`.
 *
 * Compares as minutes past midnight rather than as strings so that a slot is
 * still honoured if a tick lands late: 09:00 is due at 09:30 too. That is what
 * makes a missed tick recover instead of waiting a full day.
 */
const isSlotDue = ({ now, time }: { now: Date; time: string }): boolean => {
  const [slotHours = '0', slotMinutes = '0'] = time.split(':');
  const slotTotal = Number(slotHours) * 60 + Number(slotMinutes);

  return now.getHours() * 60 + now.getMinutes() >= slotTotal;
};

/**
 * Runs one sweep: every account whose slot has arrived and has not been claimed
 * today is checked in.
 *
 * A fresh status is read per account rather than trusting the scheduler's own
 * bookkeeping, because the account may also have been checked in manually or by
 * another instance.
 */
export const runAutoCheckinTick = async (
  now: Date = new Date(),
): Promise<string[]> => {
  const credentials = await listEligibleCredentialRecords();
  const today = localDateKey(now);
  const due = credentials.filter((credential) => {
    const { enabled, time } = getAutoCheckinSettings(credential.data);

    if (!enabled) return false;
    if (credential.data.auto_checkin_last_date === today) return false;

    return isSlotDue({ now, time });
  });

  if (!due.length) return [];

  const checkedIn: string[] = [];

  for (
    let index = 0;
    index < due.length && checkedIn.length < MAX_PER_TICK;
    index += 1
  ) {
    const credential = due[index];

    if (!credential) continue;

    try {
      // Skip accounts already claimed today, so a restart or a second instance
      // does not spend a call on an account that has nothing to collect.
      const [status] = await getAccountStatus([credential.filename]);

      if (status?.checkin.claimed === true) {
        continue;
      }

      const result = await checkinAccount(credential.filename);
      const succeeded = result.checkin.claimed === true || !result.error;

      if (!succeeded) continue;

      checkedIn.push(credential.filename);

      // Only recorded on success: a failed claim must stay due so the next
      // tick retries rather than waiting until tomorrow.
      try {
        await recordAutoCheckinRun(credential.filename, today);
      } catch (error) {
        console.warn(
          `[CodeBuddy2API] Unable to record automatic check-in for ${credential.filename}`,
          error,
        );
      }
    } catch (error) {
      console.warn(
        `[CodeBuddy2API] Automatic check-in failed for ${credential.filename}`,
        error,
      );
    }
  }

  return checkedIn;
};

/**
 * Starts the interval.
 *
 * Guarded on `globalThis` because Next.js can re-evaluate modules (dev HMR,
 * multiple route bundles importing this) and each evaluation would otherwise
 * add another interval. The timer is unref'd so it never keeps the process
 * alive on its own.
 */
export const startAutoCheckinScheduler = (): void => {
  if (globalSchedulerState.__codebuddy2apiAutoCheckin__) return;

  const state = {
    ticking: false,
    timer: setInterval(() => {
      // A tick still running when the next one is due would otherwise overlap
      // and double-claim; skipping is safe because the next tick catches up.
      if (state.ticking) return;

      state.ticking = true;

      void runAutoCheckinTick()
        .catch((error) => {
          console.warn('[CodeBuddy2API] Automatic check-in tick failed', error);
        })
        .finally(() => {
          state.ticking = false;
        });
    }, TICK_INTERVAL_MS),
  };

  state.timer.unref?.();
  globalSchedulerState.__codebuddy2apiAutoCheckin__ = state;

  // One early sweep so a process starting after its slot still catches up.
  setTimeout(() => {
    void runAutoCheckinTick().catch((error) => {
      console.warn('[CodeBuddy2API] Automatic check-in tick failed', error);
    });
  }, START_DELAY_MS).unref?.();
};

/** Test seam: stops the interval and forgets the guard. */
export const stopAutoCheckinScheduler = (): void => {
  const state = globalSchedulerState.__codebuddy2apiAutoCheckin__;

  if (!state) return;

  clearInterval(state.timer);
  delete globalSchedulerState.__codebuddy2apiAutoCheckin__;
};
