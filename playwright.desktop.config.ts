import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const e2eRoot = path.join('.tmp-e2e', String(process.pid));
/**
 * Overridable because `8001` is the port a local `bun run dev` or a Docker
 * deployment is already on, and Playwright cannot tell its own server from one
 * that was there first — with the port taken, it would happily run these tests
 * against somebody else's build.
 */
const port = process.env.E2E_DESKTOP_PORT ?? '8001';

/**
 * The console as the desktop app opens it.
 *
 * Desktop mode is an environment variable the server reads when it boots, so
 * this is a whole second Playwright run rather than a second project: the page
 * under test is the same console, started the way the app starts it. It reuses
 * the web server's port, which is why the two runs must not overlap.
 */
export default defineConfig({
  testDir: './e2e/desktop',
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-desktop' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run dev -- --hostname 127.0.0.1 --port ${port}`,
    env: {
      ...process.env,
      CODEBUDDY_API_ENDPOINT: 'http://127.0.0.1:65535',
      CODEBUDDY_CREDENTIALS_DIR: path.join(e2eRoot, '.codebuddy_creds'),
      CODEBUDDY_DESKTOP: '1',
      // Its own directory, so a port saved here cannot touch a real install.
      CODEBUDDY_DESKTOP_USER_DATA_DIR: path.join(e2eRoot, 'desktop-user-data'),
      CODEBUDDY_STORAGE_FILE_DIR: path.join(e2eRoot, '.codebuddy_data'),
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}/health`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
