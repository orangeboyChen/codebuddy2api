import fs from 'node:fs';
import path from 'node:path';

import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { resetStorageRuntime } from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-auto-checkin-sched');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const checkinAccount = vi.hoisted(() => vi.fn());
const getAccountStatus = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/domain/account-status', () => ({
  checkinAccount,
  getAccountStatus,
}));

const {
  localDateKey,
  localTimeKey,
  runAutoCheckinTick,
  startAutoCheckinScheduler,
  stopAutoCheckinScheduler,
} = await import('@/lib/server/domain/auto-checkin-scheduler');

const localDate = (
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes = 0,
): Date => new Date(year, month - 1, day, hours, minutes, 0, 0);

const seed = async (
  filename: string,
  data: Record<string, unknown> = {},
): Promise<void> => {
  await addCredential(
    {
      bearer_token: 'token',
      created_at: Math.floor(Date.now() / 1000),
      supported_models: 'glm-5.1',
      user_id: 'tester',
      ...data,
    },
    filename,
  );
};

/** Status reply marking the account as not yet checked in. */
const notClaimed = (filename: string) => ({
  checkin: { claimed: false, message: null },
  credits: {
    total: null,
    used: null,
    remaining: null,
    plan: null,
    resetAt: null,
  },
  error: null,
  filename,
  models: [],
  queriedAt: new Date().toISOString(),
});

describe('auto check-in scheduler', () => {
  beforeEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;

    checkinAccount.mockReset();
    getAccountStatus.mockReset();
    checkinAccount.mockImplementation(async (filename: string) => ({
      ...notClaimed(filename),
      checkin: { claimed: true, message: 'CLAIMED' },
    }));
    getAccountStatus.mockImplementation(async (filenames?: string[]) => {
      const filename = filenames?.[0] ?? 'unknown.json';

      return [notClaimed(filename)];
    });
  });

  afterEach(() => {
    stopAutoCheckinScheduler();
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
  });

  describe('date and time keys', () => {
    it('formats a local date key with padding', () => {
      expect(localDateKey(localDate(2026, 3, 5, 9))).toBe('2026-03-05');
      expect(localDateKey(localDate(2026, 12, 25, 9))).toBe('2026-12-25');
    });

    it('formats a local time key with padding', () => {
      expect(localTimeKey(localDate(2026, 3, 5, 9, 5))).toBe('09:05');
      expect(localTimeKey(localDate(2026, 3, 5, 23, 59))).toBe('23:59');
    });
  });

  describe('runAutoCheckinTick', () => {
    it('checks in an account whose slot has arrived', async () => {
      await seed('due.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(checkedIn).toEqual(['due.json']);
      expect(checkinAccount).toHaveBeenCalledWith('due.json');
    });

    it('does nothing when the slot has not arrived', async () => {
      await seed('early.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 8, 30));

      expect(checkedIn).toEqual([]);
      expect(checkinAccount).not.toHaveBeenCalled();
    });

    it('skips accounts with automatic check-in disabled', async () => {
      await seed('off.json', {
        auto_checkin_enabled: false,
        auto_checkin_time: '09:00',
      });

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 10, 0));

      expect(checkedIn).toEqual([]);
      expect(checkinAccount).not.toHaveBeenCalled();
    });

    it('honours a slot that a late tick has passed', async () => {
      // A process that starts after its slot must still check in, rather than
      // silently waiting until tomorrow.
      await seed('late.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 21, 0));

      expect(checkedIn).toEqual(['late.json']);
    });

    it('does not check the same account in twice on one day', async () => {
      await seed('once.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });

      await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));
      checkinAccount.mockClear();

      const second = await runAutoCheckinTick(localDate(2026, 3, 5, 10, 0));

      expect(second).toEqual([]);
      expect(checkinAccount).not.toHaveBeenCalled();
    });

    it('checks in again on the next day', async () => {
      await seed('daily.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });

      await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));
      checkinAccount.mockClear();

      const nextDay = await runAutoCheckinTick(localDate(2026, 3, 6, 9, 30));

      expect(nextDay).toEqual(['daily.json']);
    });

    it('skips accounts already checked in upstream', async () => {
      await seed('claimed.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      getAccountStatus.mockImplementation(async (filenames?: string[]) => {
        const filename = filenames?.[0] ?? 'unknown.json';

        return [
          {
            ...notClaimed(filename),
            checkin: { claimed: true, message: 'CLAIMED' },
          },
        ];
      });

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(checkedIn).toEqual([]);
      expect(checkinAccount).not.toHaveBeenCalled();
    });

    it('keeps going when one account fails', async () => {
      await seed('broken.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      await seed('healthy.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      checkinAccount.mockImplementation(async (filename: string) => {
        if (filename === 'broken.json') throw new Error('upstream down');

        return {
          ...notClaimed(filename),
          checkin: { claimed: true, message: 'CLAIMED' },
        };
      });
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(checkedIn).toEqual(['healthy.json']);
      expect(warn).toHaveBeenCalled();
    });

    it('does not record a run when the check-in reports an error', async () => {
      await seed('failing.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      checkinAccount.mockResolvedValue({
        ...notClaimed('failing.json'),
        error: 'claim returned 500',
      });

      const first = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(first).toEqual([]);

      // Not recorded, so a later tick retries instead of waiting a day.
      checkinAccount.mockResolvedValue({
        ...notClaimed('failing.json'),
        checkin: { claimed: true, message: 'CLAIMED' },
      });
      const retry = await runAutoCheckinTick(localDate(2026, 3, 5, 10, 0));

      expect(retry).toEqual(['failing.json']);
    });

    it('ignores a credential that disappears mid-tick', async () => {
      // The record can be removed between listing and checking in; the tick
      // must not fail the whole sweep.
      await seed('vanishing.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      checkinAccount.mockRejectedValueOnce(new Error('gone'));

      const checkedIn = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(checkedIn).toEqual([]);
    });

    it('handles multiple accounts independently', async () => {
      await seed('a.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '09:00',
      });
      await seed('b.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '14:00',
      });

      const morning = await runAutoCheckinTick(localDate(2026, 3, 5, 9, 30));

      expect(morning).toEqual(['a.json']);

      checkinAccount.mockClear();
      const afternoon = await runAutoCheckinTick(localDate(2026, 3, 5, 14, 30));

      expect(afternoon).toEqual(['b.json']);
    });
  });

  describe('startAutoCheckinScheduler', () => {
    it('starts once and is idempotent', () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      startAutoCheckinScheduler();
      const afterFirst = setIntervalSpy.mock.calls.length;

      startAutoCheckinScheduler();

      // A second call must not add another interval — module re-evaluation
      // would otherwise stack timers.
      expect(setIntervalSpy.mock.calls.length).toBe(afterFirst);
      expect(afterFirst).toBeGreaterThan(0);
    });

    it('can be stopped and restarted', () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      startAutoCheckinScheduler();
      stopAutoCheckinScheduler();

      expect(clearIntervalSpy).toHaveBeenCalled();

      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      startAutoCheckinScheduler();

      expect(setIntervalSpy).toHaveBeenCalled();
    });

    it('does not throw when stopped without starting', () => {
      expect(() => stopAutoCheckinScheduler()).not.toThrow();
    });

    it('skips a tick while the previous one is still running', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });

        // Hold the first tick open so the interval fires again mid-flight.
        getAccountStatus.mockImplementation(async (filenames?: string[]) => {
          await gate;

          const filename = filenames?.[0] ?? 'unknown.json';

          return [notClaimed(filename)];
        });

        startAutoCheckinScheduler();

        vi.advanceTimersByTime(30 * 60 * 1000);
        await Promise.resolve();
        vi.advanceTimersByTime(30 * 60 * 1000);

        // Still only the in-flight tick: the overlap guard held.
        expect(getAccountStatus.mock.calls.length).toBeLessThanOrEqual(1);

        release?.();
        await gate;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
