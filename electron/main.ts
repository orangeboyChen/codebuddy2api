import fs from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} from 'electron';

import { localeCookieName } from '../lib/i18n/cookie-names';
import {
  buildGatewayEnv,
  startGateway,
  type GatewayHandle,
} from '../lib/server/electron/gateway';
import {
  ensureDesktopDirectories,
  ensureDesktopEncryptionKey,
  resolveAppBundleDir,
  resolveDesktopPaths,
  resolveGatewayDir,
} from '../lib/server/electron/paths';
import { findAvailablePort } from '../lib/server/electron/ports';
import {
  DESKTOP_SETTINGS_FILENAME,
  DESKTOP_VERSION_COOKIE,
  defaultDesktopSettings,
  desktopSettingsPath,
  normalizeDesktopBackend,
  readDesktopSettings,
  resolveDesktopPreferredPort,
  writeDesktopSettings,
  type DesktopBackend,
  type DesktopSettings,
} from '../lib/server/electron/settings';
import {
  desktopText,
  statusText,
  usageText,
  type DesktopText,
} from '../lib/server/electron/desktop-text';
import {
  adminCookieHeader,
  fetchTodayUsage,
  type DesktopUsage,
} from '../lib/server/electron/usage';

const WINDOW_HEIGHT = 880;
const WINDOW_WIDTH = 1360;
const MIN_WINDOW_HEIGHT = 640;
const MIN_WINDOW_WIDTH = 960;
const BACKEND_WINDOW_HEIGHT = 520;
const BACKEND_WINDOW_WIDTH = 560;
const TRAY_ICON_SIZE = 16;
/**
 * How long quitting waits for a gateway that is still starting. The wait is
 * only ever about stopping the child cleanly, so it stays short.
 */
const QUIT_GRACE_MS = 2_000;
/**
 * Long enough for the console's save request to finish before the gateway that
 * is answering it goes away.
 */
const RESTART_DEBOUNCE_MS = 750;
/**
 * How often the menu bar item asks for today's token counts. A minute: the
 * console is where the numbers are watched, the menu bar is where they are
 * glanced at.
 */
const USAGE_POLL_MS = 60_000;
/**
 * A day. Long enough that a console still knows which build opened it after the
 * app has been closed and started again.
 */
const DESKTOP_VERSION_COOKIE_TTL_SECONDS = 24 * 60 * 60;
/**
 * How long the console is given to load before the shell sends the window there
 * again. Generous: a real first render is expected to beat it, so the second
 * attempt is only ever reached by a load that has stopped making progress.
 */
const CONSOLE_LOAD_TIMEOUT_MS = 10_000;

type GatewayStatus = 'failed' | 'running' | 'starting';

interface Cookie {
  name: string;
  value: string;
}

let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let backendWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let status: GatewayStatus = 'starting';
let userDataDir = '';
let restartTimer: NodeJS.Timeout | null = null;
let usageTimer: NodeJS.Timeout | null = null;
let restarting = false;
let quitting = false;
/** The gateway being started: its child exists, its handle does not yet. */
let pendingStart: Promise<GatewayHandle> | null = null;
/**
 * The origin the console is served from. It is not fixed: the gateway moves to
 * a new port when the port setting changes, and the backend can be switched to
 * a deployment the user already runs.
 */
let consoleOrigin = '';
/**
 * Where the console comes from: the gateway bundled into the app, or a
 * deployment the user already runs. Everything else follows from it.
 */
let backend: DesktopBackend = { mode: 'local' };
/** Today's token counts, once a backend has answered. */
let todayUsage: DesktopUsage | null = null;
let usageLoaded = false;
/** The locale the console is showing — the menu bar item speaks it too. */
let locale = 'en-US';
/**
 * The settings already applied, so the app does not react to the writes it
 * makes itself.
 */
let appliedSettings: DesktopSettings = defaultDesktopSettings();
/** Whether a backend has ever been chosen: a first launch has to ask. */
let backendChosen = false;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const delay = (ms: number): Promise<null> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, ms);
  });

const text = (): DesktopText => desktopText(locale);

const sameBackend = (a: DesktopBackend, b: DesktopBackend): boolean => {
  if (a.mode !== b.mode) {
    return false;
  }

  return a.mode === 'remote' && b.mode === 'remote' ? a.url === b.url : true;
};

const sameSettings = (a: DesktopSettings, b: DesktopSettings): boolean =>
  a.port === b.port && sameBackend(a.backend, b.backend);

/**
 * The address the console is served from, or an empty string while there is
 * none — a gateway that has not started yet.
 */
const consoleBaseUrl = (): string =>
  backend.mode === 'remote' ? backend.url : (gateway?.url ?? '');

/**
 * What to call the backend in the menu: the loopback port the gateway is on, or
 * the host of a deployment the user named.
 */
const backendAddress = (): string =>
  backend.mode === 'remote'
    ? new URL(backend.url).host
    : gateway
      ? `127.0.0.1:${gateway.port}`
      : '…';

const backendLabel = (): string =>
  backend.mode === 'remote' ? new URL(backend.url).host : text().backendLocal;

/**
 * Whether a navigation stays inside the console.
 *
 * Compared as a whole origin rather than by prefix, because `startsWith` would
 * let `http://127.0.0.1:8001.evil.example` through, and against the *current*
 * origin rather than the one the window was opened with, because the port
 * changes underneath it.
 */
const isConsoleUrl = (target: string): boolean => {
  try {
    return new URL(target).origin === consoleOrigin;
  } catch {
    // Not even an absolute URL: nothing to allow.
    return false;
  }
};

/**
 * Hands a link to the system browser. Anything that is not http(s) is dropped
 * instead: this window is the admin console, and a `file:` or `javascript:`
 * URL reaching the shell is never what the click meant.
 */
const openExternally = (target: string): void => {
  try {
    const parsed = new URL(target);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return;
    }

    void shell.openExternal(parsed.href);
  } catch {
    // Unparseable target: nothing to open.
  }
};

/**
 * The address the window should be sent to after the gateway moved. It keeps
 * the page the user was on — a port saved from Settings should not throw them
 * back to the dashboard.
 */
const retargetUrl = (window: BrowserWindow, url: string): string => {
  const current = window.webContents.getURL();

  if (current) {
    try {
      const parsed = new URL(current);

      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return `${url}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {
      // Unparseable: fall through to the console root.
    }
  }

  return `${url}/dashboard`;
};

/**
 * Tells the console which build of the app is opening it, so its About tab can
 * name the desktop version. Nothing breaks without it: the tab then has no
 * desktop version to show.
 */
const shareDesktopVersion = async (origin: string): Promise<void> => {
  try {
    await session.defaultSession.cookies.set({
      expirationDate:
        Math.floor(Date.now() / 1_000) + DESKTOP_VERSION_COOKIE_TTL_SECONDS,
      name: DESKTOP_VERSION_COOKIE,
      url: `${origin}/`,
      value: app.getVersion(),
    });
  } catch {
    // A cookie jar that refuses the write is not worth failing a launch over.
  }
};

/**
 * Sends a window to the console, keeping the navigation allow-list and the
 * version cookie in step with where it is going.
 */
const loadConsole = async (
  window: BrowserWindow,
  url: string,
): Promise<void> => {
  consoleOrigin = new URL(url).origin;
  await shareDesktopVersion(consoleOrigin);

  // Twice, because the first navigation of a cold app can stall: it neither
  // finishes nor fails, and a window that never gets a first frame stays
  // hidden, so the launch would leave nothing at all to look at. A second
  // attempt is what gets it moving.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await Promise.race([
      window
        .loadURL(url)
        // The window went away mid-load, or the backend is not answering: the
        // console can be reopened from the menu bar item.
        .then(
          () => 'loaded',
          () => 'failed',
        ),
      delay(CONSOLE_LOAD_TIMEOUT_MS).then(() => 'stalled'),
    ]);

    if (outcome !== 'stalled') {
      return;
    }
  }
};

const createMainWindow = (url: string): BrowserWindow => {
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#16161a',
    height: WINDOW_HEIGHT,
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    show: false,
    title: 'CodeBuddy2API',
    width: WINDOW_WIDTH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Links to the upstream CodeBuddy console and to the docs must open in the
  // system browser: this window is the admin console, not a web browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target);

    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (isConsoleUrl(target)) {
      return;
    }

    event.preventDefault();
    openExternally(target);
  });

  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  void loadConsole(window, url);

  return window;
};

/**
 * Opens the console on whichever backend is in use — the dashboard, since a
 * backend switch is a fresh start rather than a page reload.
 */
const openConsole = async (baseUrl: string): Promise<void> => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await loadConsole(mainWindow, `${baseUrl}/dashboard`);

    return;
  }

  mainWindow = createMainWindow(`${baseUrl}/dashboard`);
};

/**
 * The one console window the app ever opens.
 *
 * Every path that could open the console — a second launch, the dock icon, the
 * menu bar item — goes through here, so an install that is already running
 * never grows a second window or a second gateway.
 */
const showMainWindow = (): void => {
  // A launch that is still asking which backend to use has no console to show
  // yet, and the question is the thing to answer first.
  if (backendWindow && !backendWindow.isDestroyed()) {
    backendWindow.focus();

    return;
  }

  if (mainWindow) {
    if (mainWindow.isDestroyed()) {
      mainWindow = null;
    } else {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();

      return;
    }
  }

  const baseUrl = consoleBaseUrl();

  if (baseUrl) {
    mainWindow = createMainWindow(`${baseUrl}/dashboard`);
  }
};

const statusLabel = (): string => statusText(text(), status, backendAddress());

const usageLabel = (): string =>
  // `…` until the backend has answered: claiming zero tokens before the first
  // answer is a number the user would have to distrust.
  usageLoaded ? usageText(text(), todayUsage, locale) : '…';

const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    { enabled: false, label: `CodeBuddy2API · ${statusLabel()}` },
    { enabled: false, label: usageLabel() },
    { type: 'separator' },
    { click: () => showMainWindow(), label: text().openConsole },
    {
      click: () => {
        const baseUrl = consoleBaseUrl();

        if (baseUrl) {
          clipboard.writeText(baseUrl);
        }
      },
      enabled: Boolean(consoleBaseUrl()),
      label: text().copyAddress,
    },
    { type: 'separator' },
    { enabled: false, label: `${text().backend}: ${backendLabel()}` },
    { click: () => openBackendWindow(), label: text().changeBackend },
    { type: 'separator' },
    { click: () => app.quit(), label: text().quit },
  ]);

const refreshTray = (): void => {
  if (!tray) {
    return;
  }

  tray.setToolTip(`CodeBuddy2API · ${statusLabel()} · ${usageLabel()}`);
  tray.setContextMenu(buildTrayMenu());

  // macOS only: a short title beside the icon. Today's usage is the number
  // worth having in front of you; the address is a click away.
  if (process.platform === 'darwin') {
    tray.setTitle(usageLabel());
  }
};

/**
 * The files shipped next to this bundle: the tray icon, the preload script and
 * the page that asks which backend to use.
 */
const bundleDir = (): string =>
  resolveAppBundleDir({ appPath: app.getAppPath() });

/**
 * The menu bar item, which is what makes the app's state visible while the
 * console window is closed — the gateway keeps serving `/v1/*` with no window
 * open, and otherwise nothing would say so.
 */
const createTray = (): void => {
  const iconPath = path.join(bundleDir(), 'tray.png');

  if (!fs.existsSync(iconPath)) {
    return;
  }

  // The bytes are read here rather than handed to `createFromPath`, whose own
  // file read does not go through `app.asar` — in a packaged app the icon sits
  // inside the archive next to this bundle.
  const icon = nativeImage.createFromBuffer(fs.readFileSync(iconPath));

  if (icon.isEmpty()) {
    return;
  }

  // macOS draws menu bar icons from their alpha channel only, so the icon is
  // marked as a template instead of shipping a separate monochrome file.
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(
    icon.resize({ height: TRAY_ICON_SIZE, width: TRAY_ICON_SIZE }),
  );

  // On macOS a click opens the menu; elsewhere the menu is not reachable
  // without one, so the click opens the console instead.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      showMainWindow();
    });
  }

  refreshTray();
};

const launchGateway = async (port: number): Promise<GatewayHandle> => {
  const paths = resolveDesktopPaths(userDataDir);

  ensureDesktopDirectories(paths);

  return startGateway({
    env: buildGatewayEnv({
      encryptionKey: ensureDesktopEncryptionKey(paths.keyFile),
      paths,
      port,
    }),
    gatewayDir: resolveGatewayDir({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    }),
    nodePath: process.execPath,
    // The gateway can also die later — a crash, or a database that stops
    // answering. Nothing restarts it then, but the menu bar must stop claiming
    // it is running.
    onUnexpectedExit: (error) => {
      gateway = null;
      status = 'failed';
      refreshTray();
      dialog.showErrorBox(
        'CodeBuddy2API',
        `The local gateway stopped unexpectedly.\n\n${describeError(error)}`,
      );
    },
    port,
  });
};

const scheduleRestart = (): void => {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartGateway();
  }, RESTART_DEBOUNCE_MS);
};

/**
 * Starts a fresh gateway on the port now saved in the desktop settings and
 * sends the open window to its new address. Reached when the console saves a
 * port, and reused for the first launch.
 */
const restartGateway = async (): Promise<void> => {
  // A remote backend is a deployment someone else runs: there is no gateway
  // here to restart, and `openConsole` is what follows a switch to it.
  if (backend.mode !== 'local' || quitting) {
    return;
  }

  if (restarting) {
    scheduleRestart();

    return;
  }

  restarting = true;
  status = 'starting';
  refreshTray();

  try {
    // The gateway that is running still holds its port, so probing before
    // stopping it would reject the port the app is already on — the one just
    // saved included — and settle on the next one instead. Release it first.
    gateway?.stop();
    gateway = null;

    const port = await findAvailablePort({
      preferred: resolveDesktopPreferredPort(userDataDir, process.env),
    });

    pendingStart = launchGateway(port);
    gateway = await pendingStart;
    pendingStart = null;

    // The port probe and the health check take seconds, and the backend can
    // become remote meanwhile — give this gateway back instead of steering the
    // console to an address the app has already walked away from.
    if (quitting || backend.mode !== 'local') {
      gateway.stop();
      gateway = null;

      return;
    }

    consoleOrigin = new URL(gateway.url).origin;
    status = 'running';
    refreshTray();
  } catch (error) {
    gateway = null;
    status = 'failed';
    refreshTray();
    dialog.showErrorBox(
      'CodeBuddy2API',
      `The local gateway failed to start.\n\n${describeError(error)}`,
    );
  } finally {
    restarting = false;
  }

  // The console is served by the gateway, so it has to follow it. Kept out of
  // the block above: a window that was closed while the gateway was starting
  // makes this throw, and that must not mark a healthy gateway as failed.
  if (gateway && mainWindow && !mainWindow.isDestroyed()) {
    await loadConsole(mainWindow, retargetUrl(mainWindow, gateway.url));
  }

  void refreshUsage();
};

/**
 * Asks whichever backend is in use for today's token counts, and picks up the
 * locale the console is showing on the way — the menu bar item speaks the
 * console's language, not the system's.
 */
const refreshUsage = async (): Promise<void> => {
  const baseUrl = consoleBaseUrl();

  if (!baseUrl) {
    return;
  }

  let cookies: Cookie[] = [];

  try {
    cookies = await session.defaultSession.cookies.get({ url: `${baseUrl}/` });
  } catch {
    // No cookie jar: a remote deployment that wants a sign-in then answers
    // with nothing, which is what the menu bar shows.
  }

  const consoleLocale = cookies.find(
    (it) => it.name === localeCookieName,
  )?.value;

  if (consoleLocale) {
    locale = consoleLocale;
  }

  todayUsage = await fetchTodayUsage({
    baseUrl,
    cookie: adminCookieHeader(cookies),
  });
  usageLoaded = true;
  refreshTray();
};

const startUsagePolling = (): void => {
  if (usageTimer) {
    return;
  }

  usageTimer = setInterval(() => {
    void refreshUsage();
  }, USAGE_POLL_MS);
};

/**
 * Switches the app to a backend and reopens the console on it.
 *
 * `persist` is set when the choice came from the window that asks: the settings
 * file is then the record of the choice, and the watcher leaves that write
 * alone.
 */
const applyBackend = async (
  next: DesktopBackend,
  { persist = false }: { persist?: boolean } = {},
): Promise<void> => {
  const chosen = normalizeDesktopBackend(next);

  if (persist) {
    try {
      appliedSettings = writeDesktopSettings(userDataDir, {
        backend: chosen,
        port: readDesktopSettings(userDataDir).port,
      });
    } catch (error) {
      // A `userData` the app cannot write to still leaves the choice usable for
      // this run — it just will not be there next time.
      dialog.showErrorBox(
        'CodeBuddy2API',
        `Could not save the backend.\n\n${describeError(error)}`,
      );
    }

    backendChosen = true;
  }

  backend = chosen;
  todayUsage = null;
  usageLoaded = false;
  refreshTray();

  if (backend.mode === 'local') {
    await restartGateway();

    if (status === 'running') {
      showMainWindow();
    }

    return;
  }

  // No gateway of ours to run: the deployment the user named *is* the console.
  gateway?.stop();
  gateway = null;
  status = 'running';
  refreshTray();

  await openConsole(backend.url);
  void refreshUsage();
};

/**
 * The window that asks which backend to use.
 *
 * It is a bundled page rather than a console page: it has to work before there
 * is a gateway to serve one, and it is the only thing in the app that can
 * change a setting the gateway reads to start.
 */
const openBackendWindow = (): void => {
  if (backendWindow) {
    if (backendWindow.isDestroyed()) {
      backendWindow = null;
    } else {
      backendWindow.focus();

      return;
    }
  }

  const window = new BrowserWindow({
    autoHideMenuBar: true,
    height: BACKEND_WINDOW_HEIGHT,
    resizable: false,
    title: 'CodeBuddy2API',
    width: BACKEND_WINDOW_WIDTH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(bundleDir(), 'preload.js'),
      sandbox: true,
      spellcheck: false,
    },
  });

  window.on('closed', () => {
    backendWindow = null;

    // Asked and not answered: the app still has to run, so it takes the local
    // gateway rather than leaving the user with nothing.
    if (!backendChosen) {
      void applyBackend({ mode: 'local' }, { persist: true });
    }
  });

  backendWindow = window;

  void window.loadFile(path.join(bundleDir(), 'backend.html'));
};

/**
 * Watches the desktop settings so a change made in the console takes effect
 * without restarting the app.
 *
 * The directory is watched rather than the file, because the file does not
 * exist until a setting is changed for the first time; every other write in
 * `userData` — the database above all — is filtered out by name.
 */
const watchDesktopSettings = (): void => {
  try {
    fs.watch(userDataDir, (_event, filename) => {
      // A nameless event is not evidence that the settings changed.
      if (filename !== DESKTOP_SETTINGS_FILENAME) {
        return;
      }

      const next = readDesktopSettings(userDataDir);

      // Our own write, or one that changes nothing: nothing to follow.
      if (sameSettings(next, appliedSettings)) {
        return;
      }

      appliedSettings = next;

      if (!sameBackend(next.backend, backend)) {
        void applyBackend(next.backend);

        return;
      }

      scheduleRestart();
    });
  } catch {
    // Nothing to watch: a changed setting then applies on the next launch.
  }
};

const startBackend = async (): Promise<void> => {
  if (backend.mode === 'remote') {
    status = 'running';
    refreshTray();

    await openConsole(backend.url);
    void refreshUsage();

    return;
  }

  await restartGateway();

  if (status === 'running') {
    showMainWindow();

    return;
  }

  // Nothing to serve and no window to show: quit, unless the menu bar item can
  // report what went wrong.
  if (!tray) {
    app.quit();
  }
};

const bootstrap = async (): Promise<void> => {
  userDataDir = app.getPath('userData');

  const settings = readDesktopSettings(userDataDir);
  // A settings file exists once a backend has been chosen — or once any other
  // desktop setting has been saved, which is a choice of the local gateway in
  // itself.
  const firstRun = !fs.existsSync(desktopSettingsPath(userDataDir));

  appliedSettings = settings;
  backend = settings.backend;
  backendChosen = !firstRun;

  createTray();
  watchDesktopSettings();
  startUsagePolling();

  // A first launch asks before it starts anything: the answer decides whether a
  // gateway is even needed.
  if (firstRun) {
    openBackendWindow();

    return;
  }

  await startBackend();
};

ipcMain.handle('desktop:info', () => ({
  backend,
  locale,
  text: text(),
}));

ipcMain.handle('desktop:set-backend', (_event, next: unknown) => {
  const window = backendWindow;

  // Normalized here, at the boundary a page can reach: the window has no say in
  // what counts as a backend.
  void applyBackend(normalizeDesktopBackend(next), { persist: true });
  window?.close();
});

// A second launch would only ever start a second gateway on a second port, so
// hand the existing window back instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  // On macOS the gateway keeps serving API clients after the console window is
  // closed; elsewhere closing the window is quitting the app. A launch that is
  // still asking which backend to use, or still starting a gateway, has a
  // window of its own to lose first.
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin' || backendWindow || restarting) {
      return;
    }

    app.quit();
  });

  app.on('activate', () => {
    showMainWindow();
  });

  app.on('before-quit', (event) => {
    if (quitting) {
      return;
    }

    quitting = true;
    event.preventDefault();

    void (async () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      if (usageTimer) {
        clearInterval(usageTimer);
        usageTimer = null;
      }

      gateway?.stop();

      // A gateway that is still starting has already spawned a child, but the
      // handle that could stop it does not exist until it is healthy. Wait for
      // it, briefly, so quitting mid-restart cannot leave a gateway behind
      // holding the port the next launch wants.
      if (pendingStart) {
        const started = await Promise.race([
          pendingStart.catch(() => null),
          delay(QUIT_GRACE_MS),
        ]);

        started?.stop();
      }

      app.exit();
    })();
  });

  void app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      gateway?.stop();
      status = 'failed';
      refreshTray();
      dialog.showErrorBox(
        'CodeBuddy2API',
        `The local gateway failed to start.\n\n${describeError(error)}`,
      );
      app.quit();
    }
  });
}
