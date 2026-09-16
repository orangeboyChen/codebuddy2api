/**
 * Writes per-account automatic check-in settings.
 *
 * The pure accessors live in `auto-checkin-settings.ts`; see that module for why
 * the split exists. Each credential carries its own switch and time, so a
 * deployment can check in accounts on different schedules, and deleting an
 * account deletes its schedule with it.
 */

import { findCredentialRecordByFilename } from './credentials';
import {
  getAutoCheckinTime,
  isAutoCheckinEnabled,
  isValidAutoCheckinTime,
} from './auto-checkin-settings';
import { writeStorageJson } from '../storage';

export {
  AUTO_CHECKIN_MINUTE_OPTIONS,
  DEFAULT_AUTO_CHECKIN_TIME,
  getAutoCheckinSettings,
  getAutoCheckinTime,
  isAutoCheckinEnabled,
  isValidAutoCheckinTime,
} from './auto-checkin-settings';

/**
 * Applies a partial update to one credential's automatic check-in settings.
 *
 * The time is validated before anything is written, so a rejected request
 * leaves the stored schedule untouched rather than half-updated.
 */
export const updateAutoCheckinSettings = async (
  filename: string,
  update: { enabled?: unknown; time?: unknown },
): Promise<{ enabled: boolean; time: string }> => {
  const credential = await findCredentialRecordByFilename(filename);

  if (!credential) {
    throw new Error('Credential is unavailable');
  }

  let time = getAutoCheckinTime(credential.data);

  if (update.time !== undefined) {
    if (!isValidAutoCheckinTime(update.time)) {
      throw new Error('Invalid auto check-in time, expected HH:MM');
    }

    time = String(update.time).trim();
  }

  const enabled =
    update.enabled === undefined
      ? isAutoCheckinEnabled(credential.data)
      : Boolean(update.enabled);

  await writeStorageJson('credentials', filename, {
    ...credential.data,
    auto_checkin_enabled: enabled,
    auto_checkin_time: time,
  });

  return { enabled, time };
};

/**
 * Records that this account's slot for `date` has been taken.
 *
 * Written after a successful claim so a restart, or a second instance sharing
 * the same storage, does not spend another call on an account that has already
 * collected today.
 */
export const recordAutoCheckinRun = async (
  filename: string,
  date: string,
): Promise<void> => {
  const credential = await findCredentialRecordByFilename(filename);

  if (!credential) {
    return;
  }

  await writeStorageJson('credentials', filename, {
    ...credential.data,
    auto_checkin_last_date: date,
  });
};

/** Clears the recorded run date; used when an operator wants a manual re-run. */
export const resetAutoCheckinRun = async (filename: string): Promise<void> => {
  const credential = await findCredentialRecordByFilename(filename);

  if (!credential) {
    return;
  }

  await writeStorageJson('credentials', filename, {
    ...credential.data,
    auto_checkin_last_date: null,
  });
};
