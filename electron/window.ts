import type { BrowserWindow } from 'electron';

/**
 * Closes a window that is still there.
 *
 * `close()` throws on one that is not, and a window the user closed while this
 * process was busy — Escape, its own button — is one that is not. What comes
 * back from a long restart is exactly such a window: the gateway is asked,
 * seconds pass, and the answer lands on a window that has already gone. A throw
 * there takes everything after it down with it — the console that was about to
 * open, the refresh that was about to run — and says nothing at all while it
 * does.
 */
export const closeWindow = (window: BrowserWindow | null): void => {
  if (window && !window.isDestroyed()) {
    window.close();
  }
};
