import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { closeWindow } from '@/electron/window';

/**
 * Closing a window this process has been away from.
 *
 * `close()` throws on a window that has already gone, and the windows this app
 * closes are ones it has been away from: a restart is seconds long, and the
 * window that asked for it can have been closed while it was being asked. What
 * matters is not that the close happened — there is nothing to close — but that
 * it did not throw, because the next line is the console opening.
 */

/** A window, in the only two states this is asked about. */
const window = (destroyed: boolean): BrowserWindow => {
  const close = vi.fn();

  return { close, isDestroyed: () => destroyed } as unknown as BrowserWindow;
};

describe('closing a window', () => {
  it('closes one that is still there', () => {
    const open = window(false);

    closeWindow(open);

    expect(open.close).toHaveBeenCalledTimes(1);
  });

  it('leaves one that has already gone alone', () => {
    const gone = window(true);

    expect(() => closeWindow(gone)).not.toThrow();
    expect(gone.close).not.toHaveBeenCalled();
  });

  it('has nothing to do with no window at all', () => {
    expect(() => closeWindow(null)).not.toThrow();
  });
});
