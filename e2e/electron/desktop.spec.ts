import fs from 'node:fs';
import http from 'node:http';
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

/** The version the deployment in the last test answers with — never the app's. */
const DEPLOYMENT_VERSION = '9.9.9';
/** The password the locked deployment below accepts — the deployment's own. */
const DEPLOYMENT_PASSWORD = 'the-deployment-password';

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
const waitForWindow = async (
  app: ElectronApplication,
  pattern: RegExp,
): Promise<Page> => {
  let found: Page | undefined;

  await expect
    .poll(
      () => {
        found = app.windows().find((window) => pattern.test(window.url()));

        return Boolean(found);
      },
      { intervals: [500], timeout: 120_000 },
    )
    .toBe(true);

  return found as Page;
};

const waitForConsole = (app: ElectronApplication): Promise<Page> =>
  waitForWindow(app, /\/dashboard$/);

test.beforeAll(() => {
  fs.mkdirSync(userDataDir, { recursive: true });
});

test('asks which backend to use, then opens the console it starts', async () => {
  const app = await launchApp();

  // A first launch has no settings file, so it asks before starting anything.
  const chooser = await app.firstWindow();

  // A bundle that does not run leaves a blank window and nothing else to go
  // on, so the reason goes into the failure instead of the log.
  const pageErrors: string[] = [];
  chooser.on('pageerror', (error) => pageErrors.push(error.message));

  await expect.poll(() => chooser.url()).toContain('backend.html');
  await expect(chooser.locator('#title')).toHaveText('Choose a backend');

  expect(pageErrors).toEqual([]);

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

  // Nothing to sign in to: the gateway listens on loopback and the data is on
  // this machine, so there is no password to set and no panel offering one.
  await consoleWindow.goto(
    new URL('/settings', consoleWindow.url()).toString(),
  );

  await expect(consoleWindow.locator('#security')).toHaveCount(0);

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

/** The backend the next launch finds on disk, as the window itself would save it. */
const writeBackend = (url: string): void => {
  fs.writeFileSync(
    path.join(userDataDir, 'desktop-settings.json'),
    `${JSON.stringify(
      { backend: { mode: 'remote', url }, port: 8001 },
      null,
      2,
    )}\n`,
  );
};

/**
 * A deployment the user already runs, standing in for one: `/health` names this
 * service, and everything else answers with a page of its own — the page the app
 * must never put in its window.
 */
const startDeployment = async (): Promise<{
  port: number;
  stop: () => void;
}> => {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const answer = (payload: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (path === '/health') {
      answer({
        service: 'codebuddy2api',
        status: 'healthy',
        storage: 'sqlite',
      });

      return;
    }

    if (path === '/admin-api/version') {
      answer({ version: DEPLOYMENT_VERSION });

      return;
    }

    if (path === '/admin-api/auth/session') {
      answer({
        session: {
          accountConfigured: true,
          authEnabled: true,
          authenticated: true,
          passkeyCount: 0,
          passwordConfigured: true,
          usagePreferences: null,
          username: 'admin',
        },
      });

      return;
    }

    if (path === '/admin-api/settings') {
      answer({ labels: {}, settings: {} });

      return;
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>the deployment’s own page</body></html>');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as { port: number };

  return { port: address.port, stop: () => server.close() };
};

/**
 * A deployment that is locked, standing in for one: nothing answers until the
 * password is posted to `/admin-api/auth/session`, and it has a passkey saved —
 * the one thing this app's window cannot use.
 */
const startLockedDeployment = async (): Promise<{
  port: number;
  stop: () => void;
}> => {
  const server = http.createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const signedIn = (request.headers.cookie ?? '').includes(
      'deployment-session=let-me-in',
    );
    const session = {
      accountConfigured: true,
      authEnabled: true,
      authenticated: signedIn,
      passkeyCount: 1,
      passwordConfigured: true,
      usagePreferences: null,
      username: 'admin',
    };
    const answer = (
      payload: unknown,
      headers: Record<string, string> = {},
    ): void => {
      response.writeHead(200, {
        'content-type': 'application/json',
        ...headers,
      });
      response.end(JSON.stringify(payload));
    };

    if (path === '/health') {
      answer({
        service: 'codebuddy2api',
        status: 'healthy',
        storage: 'sqlite',
      });

      return;
    }

    if (path === '/admin-api/auth/session') {
      if (request.method !== 'POST') {
        answer({ session });

        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const { password } = JSON.parse(body || '{}') as { password?: string };

        if (password !== DEPLOYMENT_PASSWORD) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { message: 'Wrong password' } }),
          );

          return;
        }

        answer(
          { session: { ...session, authenticated: true }, success: true },
          { 'set-cookie': 'deployment-session=let-me-in; Path=/; HttpOnly' },
        );
      });

      return;
    }

    answer({ authenticated: signedIn });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as { port: number };

  return { port: address.port, stop: () => server.close() };
};

test('signs in to a deployment with its password, and leaves the passkey to a browser', async () => {
  const deployment = await startLockedDeployment();

  writeBackend(`http://127.0.0.1:${deployment.port}`);

  const app = await launchApp();
  const loginWindow = await waitForWindow(app, /\/login$/);

  // A passkey saved for the deployment is bound to its address, so the page
  // offers none: it says so and points at the deployment's own page instead,
  // which the shell opens in a browser.
  await expect(loginWindow.locator('#admin-passkey')).toHaveCount(0);
  await expect(
    loginWindow.locator(`a[href="http://127.0.0.1:${deployment.port}"]`),
  ).toBeVisible();

  await loginWindow.locator('#admin-username').fill('admin');
  await loginWindow.locator('#admin-password').fill(DEPLOYMENT_PASSWORD);
  await loginWindow.locator('button[type="submit"]').click();

  const consoleWindow = await waitForConsole(app);

  // The password reached the deployment, and the session it set came back:
  // what it answers now is signed in, and the cookie the console holds is the
  // one it handed out.
  const answered = await consoleWindow.evaluate(async () => {
    const response = await fetch('/admin-api/auth/session');

    return (await response.json()) as { session?: { authenticated?: boolean } };
  });

  expect(answered.session?.authenticated).toBe(true);

  await app.close();
  deployment.stop();
});

test('shows its own console for a deployment, and takes only the data from it', async () => {
  const deployment = await startDeployment();

  writeBackend(`http://127.0.0.1:${deployment.port}`);

  const app = await launchApp();
  const consoleWindow = await waitForConsole(app);

  // The console is the app's own build on loopback, not the deployment's page:
  // the address in the window is the gateway the app started here.
  expect(consoleWindow.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard$/);
  expect(await consoleWindow.title()).not.toContain(
    'the deployment’s own page',
  );

  // …and the numbers in it are the deployment's: `/admin-api` is forwarded, so
  // the version it answers with is the version it has, not the app's.
  const response = await consoleWindow.request.get(
    new URL('/admin-api/version', consoleWindow.url()).toString(),
  );

  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ version: DEPLOYMENT_VERSION });

  // So is its sign-in: the panel is not something a desktop install has, but
  // this one is a console for a deployment reachable from a network, whose
  // password and passkeys are the user's to change.
  await consoleWindow.goto(
    new URL('/settings', consoleWindow.url()).toString(),
  );

  await expect(consoleWindow.locator('#security')).toBeVisible();

  await app.close();
  deployment.stop();
});

test('says what happened when the deployment does not answer', async () => {
  // Nothing listens there: the connection is refused at once.
  writeBackend('http://127.0.0.1:1');

  const app = await launchApp();
  const window = await app.firstWindow();

  await expect.poll(() => window.url()).toContain('backend.html');
  await expect(window.locator('body')).toContainText(
    'Could not use this deployment',
  );
  // Which deployment, since that is the thing to check or to change.
  await expect(window.locator('body')).toContainText('127.0.0.1:1');

  await app.close();
});

test('refuses an address that answers, but is not this app', async () => {
  const stranger = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>somebody else’s page</body></html>');
  });

  await new Promise<void>((resolve) => {
    stranger.listen(0, '127.0.0.1', resolve);
  });

  writeBackend(
    `http://127.0.0.1:${(stranger.address() as { port: number }).port}`,
  );

  const app = await launchApp();
  const window = await app.firstWindow();

  await expect.poll(() => window.url()).toContain('backend.html');
  await expect(window.locator('body')).toContainText(
    'Could not use this deployment',
  );
  // The old behaviour was to render whatever answered. Nothing of that page is
  // in the window.
  await expect(window.locator('body')).not.toContainText(
    'somebody else’s page',
  );

  await app.close();
  stranger.close();
});
