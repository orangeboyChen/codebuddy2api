import fs from 'node:fs';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/**
 * The app itself: the shell, the window it opens and the gateway it starts.
 *
 * These run against the bundle `bun run desktop:prepare` leaves in `build/`,
 * launched the way `bun run desktop:start` launches it, and they need a
 * display — on a headless machine, `xvfb-run`.
 */
const repoRoot = path.join(__dirname, '..', '..');
const userDataDir = path.join(
  repoRoot,
  '.tmp-e2e-electron',
  String(process.pid),
);

/**
 * `ELECTRON_RUN_AS_NODE` turns the Electron binary into plain Node — it is how
 * the shell runs the gateway — so an inherited one would leave the app printing
 * Node's "bad option" for every switch instead of opening a window.
 */
const childEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (name !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) {
      env[name] = value;
    }
  }

  return env;
};

const launchApp = (): Promise<ElectronApplication> =>
  electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: childEnv(),
  });

/**
 * The console window, which only exists once the gateway behind it answers —
 * the shell opens no window before that.
 */
const waitForConsole = async (app: ElectronApplication): Promise<Page> => {
  let found: Page | undefined;

  await expect
    .poll(
      () => {
        found = app
          .windows()
          .find((window) => /\/dashboard$/.test(window.url()));

        return Boolean(found);
      },
      { intervals: [500], timeout: 120_000 },
    )
    .toBe(true);

  return found as Page;
};

test.beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
});

test('asks which backend to use, then opens the console it starts', async () => {
  const app = await launchApp();

  // A first launch has no settings file, so it asks before starting anything.
  const chooser = await app.firstWindow();

  await expect.poll(() => chooser.url()).toContain('backend.html');
  await expect(chooser.locator('#title')).toHaveText('Choose a backend');

  await chooser.locator('#save').click();

  const consoleWindow = await waitForConsole(app);

  expect(consoleWindow.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard$/);

  // The console it opened is the app's own build: the gateway the shell starts
  // is the app, and desktop mode answers the version API with no sign-in. This
  // is the number the menu bar item names as the app version.
  const version = await app.evaluate(({ app }) => app.getVersion());
  const response = await consoleWindow.request.get(
    new URL('/admin-api/version', consoleWindow.url()).toString(),
  );

  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ version });

  await app.close();
});

test('opens the console straight away once a backend has been chosen', async () => {
  const app = await launchApp();

  // No window asking anything this time: the choice the last launch saved is
  // still on disk, in the same user data directory.
  const consoleWindow = await waitForConsole(app);

  expect(consoleWindow.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard$/);
  expect(app.windows()).toHaveLength(1);

  await app.close();
});
