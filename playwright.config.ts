import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const e2eRoot = path.join('.tmp-e2e', String(process.pid));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8001',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run dev -- --hostname 127.0.0.1 --port 8001',
    env: {
      ...process.env,
      CODEBUDDY_API_ENDPOINT: 'http://127.0.0.1:65535',
      CODEBUDDY_CREDENTIALS_DIR: path.join(e2eRoot, '.codebuddy_creds'),
      CODEBUDDY_STORAGE_FILE_DIR: path.join(e2eRoot, '.codebuddy_data'),
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: 'http://127.0.0.1:8001/health',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
