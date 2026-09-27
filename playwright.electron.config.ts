import { defineConfig } from '@playwright/test';

/**
 * The desktop app itself: the Electron shell, the window it opens and the
 * gateway it starts.
 *
 * There is no web server here — the app starts its own, from the bundle
 * `bun run desktop:prepare` leaves in `build/`. That makes the run slower than
 * the console ones and keeps it separate: it needs a display, and the app it
 * exercises is a packaged one.
 */
export default defineConfig({
  testDir: './e2e/electron',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-electron' }],
  ],
  projects: [
    {
      name: 'electron',
    },
  ],
});
