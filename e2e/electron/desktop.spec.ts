import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DEFAULT_GATEWAY_PORT } from '../../lib/server/electron/ports';
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

/**
 * The question the app asks — which backend, which port — is put to the desktop
 * on a machine that has one: AppKit's dialog, a WinForms form, zenity's. Nothing
 * a test can click, and nothing a headless runner can draw, so these run with
 * the app's own window asking instead.
 */
const ASK_IN_WINDOW = { CODEBUDDY_DESKTOP_ASK: 'window' };

const launchApp = ({
  env = {},
  userData = userDataDir,
}: {
  env?: Record<string, string>;
  userData?: string;
} = {}): Promise<ElectronApplication> =>
  electron.launch({
    args: [repoRoot, `--user-data-dir=${userData}`],
    cwd: repoRoot,
    env: { ...childEnv(), ...ASK_IN_WINDOW, ...env },
  });

/**
 * A user data directory no other test has touched. Whether the app is on its
 * first launch, and which port it was saved to use, is decided by what sits in
 * one, so a test that needs its own answer has to have its own.
 */
const separateUserDataDir = (name: string): string => {
  const dir = path.join(userDataDir, name);

  fs.rmSync(dir, { force: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  return dir;
};

/** A port nothing is serving, for a test that needs one to hand to the app. */
const freePort = async (): Promise<number> => {
  const server = http.createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as { port: number };

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  return port;
};

/**
 * Something already serving a port: what a Docker deployment on 8001 looks like
 * to the app. Given no port, it takes whatever is free.
 */
const servePort = async (
  port = 0,
): Promise<{ port: number; stop: () => void }> => {
  const server = http.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const { port: listening } = server.address() as { port: number };

  return { port: listening, stop: () => server.close() };
};

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

  // The port is settled in the same window: the gateway that serves this
  // console runs on this machine either way, and it is the number the app has
  // to be told before it can start one.
  await expect(chooser.locator('#port')).toHaveValue('8001');

  expect(pageErrors).toEqual([]);

  // The size of the question it is asking: the page measures its own pane, the
  // shell follows, and the window ends up neither wider nor narrower than the
  // text inside it — which is what a hint translated into three languages
  // needs, on a computer that picked its own font.
  const pane = chooser.locator('#pane');

  await expect
    .poll(async () => {
      const [width] = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];

        return window ? window.getContentSize() : [0, 0];
      });

      return Math.abs(
        width - (await pane.evaluate((it) => it.getBoundingClientRect().width)),
      );
    })
    .toBeLessThan(1);

  const paneWidth = await pane.evaluate(
    (it) => it.getBoundingClientRect().width,
  );

  // Wide enough for the two hints, and no wider: the cap in the stylesheet is
  // what stops a long one from stretching the window across the screen.
  expect(paneWidth).toBeGreaterThan(360);
  expect(paneWidth).toBeLessThanOrEqual(480);

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

/** The settings the next launch finds on disk, as the window itself would save them. */
const writeSettings = (settings: unknown, dir: string = userDataDir): void => {
  fs.writeFileSync(
    path.join(dir, 'desktop-settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
};

test('quits when the window it asks in is closed without an answer', async () => {
  const dir = separateUserDataDir('first-run-unanswered');
  const app = await launchApp({ userData: dir });

  // A first launch has nothing behind it yet: no gateway is running, and no
  // answer is on disk to fall back on.
  const chooser = await app.firstWindow();

  await expect.poll(() => chooser.url()).toContain('backend.html');

  let closed = false;

  app.on('close', () => {
    closed = true;
  });

  await chooser.close();

  // Closed rather than answered: the app goes away instead of starting a
  // gateway nobody chose, which is the only thing a first launch could start.
  await expect.poll(() => closed, { timeout: 30_000 }).toBe(true);

  // Nothing was written, so the next launch asks the same question again.
  expect(fs.existsSync(path.join(dir, 'desktop-settings.json'))).toBe(false);
});

test('asks for another port when the one it saved is already taken', async () => {
  // Something else serving the port the app was told to use: what a Docker
  // deployment already on 8001 looks like from here.
  const taken = await servePort();
  const spare = await freePort();
  const dir = separateUserDataDir('port-taken');

  // A first launch is never reached: the port is already on disk, so the app
  // tries to start on it and has to say it cannot.
  writeSettings({ backend: { mode: 'local' }, port: taken.port }, dir);

  const app = await launchApp({ userData: dir });
  const window = await waitForWindow(app, /backend\.html$/);

  // The number it could not have, and a field to put another one in: a port is
  // the user's to choose, not the app's to guess around.
  await expect(window.locator('#portInUse')).toContainText(String(taken.port));
  await expect(window.locator('#port')).toHaveValue(String(taken.port));

  await window.locator('#port').fill(String(spare));
  await window.locator('#save').click();

  const consoleWindow = await waitForConsole(app);

  expect(consoleWindow.url()).toBe(`http://127.0.0.1:${spare}/dashboard`);

  await app.close();
  taken.stop();
});

test('asks about the default port too, once it has been saved', async () => {
  // The number the app starts on, taken by something else — a Docker deployment
  // serving 8001 is the usual reason.
  const taken = await servePort(DEFAULT_GATEWAY_PORT);
  const spare = await freePort();
  const dir = separateUserDataDir('default-port-taken');

  // Saved, so it is a promise and not a starting point: the window that asks
  // showed this number and Save was pressed with it there, even though it is
  // the one the app would have picked anyway.
  writeSettings(
    { backend: { mode: 'local' }, port: DEFAULT_GATEWAY_PORT },
    dir,
  );

  const app = await launchApp({ userData: dir });
  const window = await waitForWindow(app, /backend\.html$/);

  await expect(window.locator('#portInUse')).toContainText(
    String(DEFAULT_GATEWAY_PORT),
  );

  await window.locator('#port').fill(String(spare));
  await window.locator('#save').click();

  const consoleWindow = await waitForConsole(app);

  expect(consoleWindow.url()).toBe(`http://127.0.0.1:${spare}/dashboard`);

  await app.close();
  taken.stop();
});

/** The backend the next launch finds on disk, as the window itself would save it. */
const writeBackend = (url: string): void => {
  writeSettings({ backend: { mode: 'remote', url }, port: 8001 });
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

  // The form is a client component: filled before it hydrates, the value lands
  // in the DOM and not in React, and the submit button — which waits for both
  // fields — never enables. Filled again until it does, which is what a user
  // in front of the same window would do.
  const submit = loginWindow.locator('button[type="submit"]');

  await expect
    .poll(
      async () => {
        await loginWindow.locator('#admin-username').fill('admin');
        await loginWindow.locator('#admin-password').fill(DEPLOYMENT_PASSWORD);

        return submit.isEnabled();
      },
      { intervals: [1_000], timeout: 60_000 },
    )
    .toBe(true);

  await submit.click();

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
