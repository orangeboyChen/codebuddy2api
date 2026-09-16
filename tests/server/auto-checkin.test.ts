import fs from 'node:fs';
import path from 'node:path';

import {
  addCredential,
  findCredentialRecordByFilename,
  listCredentials,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import {
  getAutoCheckinSettings,
  getAutoCheckinTime,
  isAutoCheckinEnabled,
  isValidAutoCheckinTime,
} from '@/lib/server/domain/auto-checkin-settings';
import {
  recordAutoCheckinRun,
  resetAutoCheckinRun,
  updateAutoCheckinSettings,
} from '@/lib/server/domain/auto-checkin';
import { resetStorageRuntime } from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-auto-checkin');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

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

describe('auto check-in settings', () => {
  beforeEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
  });

  afterEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
  });

  describe('time validation', () => {
    it.each<{ expected: boolean; value: string }>([
      { expected: true, value: '09:00' },
      { expected: true, value: '00:00' },
      { expected: true, value: '23:59' },
      { expected: false, value: '9:00' },
      { expected: false, value: '24:00' },
      { expected: false, value: '12:60' },
      { expected: false, value: 'noon' },
      { expected: false, value: '' },
    ])('treats $value as valid: $expected', ({ expected, value }) => {
      expect(isValidAutoCheckinTime(value)).toBe(expected);
    });

    it('rejects non-string values', () => {
      expect(isValidAutoCheckinTime(900)).toBe(false);
      expect(isValidAutoCheckinTime(null)).toBe(false);
      expect(isValidAutoCheckinTime(undefined)).toBe(false);
    });
  });

  describe('defaults', () => {
    it('is disabled by default', async () => {
      await seed('default.json');
      const credential = await findCredentialRecordByFilename('default.json');

      expect(isAutoCheckinEnabled(credential?.data ?? {})).toBe(false);
    });

    it('falls back to a default time when unset', () => {
      expect(getAutoCheckinTime({})).toBe('09:00');
    });

    it('falls back when the stored time is malformed', () => {
      // A hand-edited file must not silently stop the account being checked in.
      expect(getAutoCheckinTime({ auto_checkin_time: 'tomorrow' })).toBe(
        '09:00',
      );
    });

    it('reads the stored time when valid', () => {
      expect(getAutoCheckinTime({ auto_checkin_time: '07:30' })).toBe('07:30');
    });

    it('reads boolean and string flags alike', () => {
      expect(isAutoCheckinEnabled({ auto_checkin_enabled: true })).toBe(true);
      expect(isAutoCheckinEnabled({ auto_checkin_enabled: 'true' })).toBe(true);
      expect(isAutoCheckinEnabled({ auto_checkin_enabled: 'false' })).toBe(
        false,
      );
    });
  });

  describe('updateAutoCheckinSettings', () => {
    it('enables and stores a time', async () => {
      await seed('save.json');

      const result = await updateAutoCheckinSettings('save.json', {
        enabled: true,
        time: '08:30',
      });

      expect(result).toEqual({ enabled: true, time: '08:30' });

      const credential = await findCredentialRecordByFilename('save.json');
      expect(getAutoCheckinSettings(credential?.data ?? {})).toEqual({
        enabled: true,
        time: '08:30',
      });
    });

    it('changes only the time when enabled is omitted', async () => {
      await seed('time-only.json');
      await updateAutoCheckinSettings('time-only.json', {
        enabled: true,
        time: '06:00',
      });

      const result = await updateAutoCheckinSettings('time-only.json', {
        time: '22:30',
      });

      expect(result).toEqual({ enabled: true, time: '22:30' });
    });

    it('changes only the switch when time is omitted', async () => {
      await seed('switch-only.json');
      await updateAutoCheckinSettings('switch-only.json', {
        enabled: false,
        time: '15:00',
      });

      const result = await updateAutoCheckinSettings('switch-only.json', {
        enabled: true,
      });

      expect(result).toEqual({ enabled: true, time: '15:00' });
    });

    it('rejects a malformed time without writing', async () => {
      await seed('bad-time.json');
      await updateAutoCheckinSettings('bad-time.json', {
        enabled: true,
        time: '07:00',
      });

      await expect(
        updateAutoCheckinSettings('bad-time.json', { time: '25:00' }),
      ).rejects.toThrow('HH:MM');

      // The previous schedule must survive a rejected update.
      const credential = await findCredentialRecordByFilename('bad-time.json');
      expect(getAutoCheckinSettings(credential?.data ?? {})).toEqual({
        enabled: true,
        time: '07:00',
      });
    });

    it('throws for an unknown credential', async () => {
      await expect(
        updateAutoCheckinSettings('missing.json', { enabled: true }),
      ).rejects.toThrow('Credential is unavailable');
    });

    it('preserves unrelated credential fields', async () => {
      await seed('preserve.json');
      await updateAutoCheckinSettings('preserve.json', { enabled: true });

      const credential = await findCredentialRecordByFilename('preserve.json');

      expect(credential?.data.supported_models).toBe('glm-5.1');
      expect(credential?.data.bearer_token).toBe('token');
    });
  });

  describe('run bookkeeping', () => {
    it('clears the recorded run date', async () => {
      await seed('reset.json');
      const credential = await findCredentialRecordByFilename('reset.json');

      await resetAutoCheckinRun('reset.json');

      const updated = await findCredentialRecordByFilename('reset.json');
      expect(updated?.data.auto_checkin_last_date).toBeNull();
      expect(credential?.data.bearer_token).toBe('token');
    });

    it('ignores a credential that no longer exists', async () => {
      await expect(resetAutoCheckinRun('gone.json')).resolves.toBeUndefined();
    });

    it('records the run date', async () => {
      await seed('recorded.json');

      await recordAutoCheckinRun('recorded.json', '2026-03-05');

      const credential = await findCredentialRecordByFilename('recorded.json');
      expect(credential?.data.auto_checkin_last_date).toBe('2026-03-05');
    });

    it('ignores recording for a credential that no longer exists', async () => {
      // The record can be removed between a successful claim and the write;
      // that must not fail the sweep.
      await expect(
        recordAutoCheckinRun('gone.json', '2026-03-05'),
      ).resolves.toBeUndefined();
    });
  });

  describe('console payload', () => {
    it('exposes the settings for each credential', async () => {
      await seed('listed.json', {
        auto_checkin_enabled: true,
        auto_checkin_time: '11:30',
      });

      const { credentials } = await listCredentials();
      const listed = credentials.find(
        (credential) =>
          (credential as { filename: string }).filename === 'listed.json',
      ) as { auto_checkin_enabled: boolean; auto_checkin_time: string };

      expect(listed.auto_checkin_enabled).toBe(true);
      expect(listed.auto_checkin_time).toBe('11:30');
    });

    it('reports defaults for a credential without settings', async () => {
      await seed('plain.json');

      const { credentials } = await listCredentials();
      const listed = credentials.find(
        (credential) =>
          (credential as { filename: string }).filename === 'plain.json',
      ) as { auto_checkin_enabled: boolean; auto_checkin_time: string };

      expect(listed.auto_checkin_enabled).toBe(false);
      expect(listed.auto_checkin_time).toBe('09:00');
    });
  });
});
