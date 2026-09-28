import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const e2eRoot = path.join('.tmp-e2e', `device-${process.pid}`);
/**
 * Overridable because `8021` may already be taken on a machine running its own
 * deployment, and Playwright cannot tell its own server from one that was there
 * first — with the port taken, it would happily run these tests against
 * somebody else's build.
 */
const port = process.env.E2E_DEVICE_PORT ?? '8021';

/**
 * A deployment, and the app that signs in to it.
 *
 * The desktop app's own sign-in is not a form in its window: it asks for two
 * codes and waits while the user approves them in a browser, on the address the
 * deployment's passkey and passwords belong to. What is tested here is that
 * whole exchange against a real server of this app's own — the app's half asked
 * over HTTP the way the app asks it, the user's half typed into the page the
 * deployment serves — which is why this is a run of its own rather than a test
 * in the console's: the console nobody signs in to cannot issue a device a
 * code, and giving it an administrator account would close the door on every
 * other run.
 */
export default defineConfig({
  testDir: './e2e/device',
  fullyParallel: false,
  workers: 1,
  // A dev server compiles each route the first time it is asked for, and the
  // pages this run drives are ones no other run ever opens.
  timeout: 120_000,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report-device' }],
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
