import fs from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  nativeImage,
  shell,
} from 'electron';

import {
  buildGatewayEnv,
  startGateway,
  type GatewayHandle,
} from '../lib/server/electron/gateway';
import {
  ensureDesktopDirectories,
  ensureDesktopEncryptionKey,
  resolveDesktopPaths,
  resolveGatewayDir,
} from '../lib/server/electron/paths';
import { findAvailablePort } from '../lib/server/electron/ports';
import {
  DESKTOP_SETTINGS_FILENAME,
  resolveDesktopPreferredPort,
} from '../lib/server/electron/settings';

const WINDOW_HEIGHT = 880;
const WINDOW_WIDTH = 1360;
const MIN_WINDOW_HEIGHT = 640;
const MIN_WINDOW_WIDTH = 960;
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

type GatewayStatus = 'failed' | 'running' | 'starting';

let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let status: GatewayStatus = 'starting';
let userDataDir = '';
let restartTimer: NodeJS.Timeout | null = null;
let restarting = false;
let quitting = false;
/** The gateway being started: its child exists, its handle does not yet. */
let pendingStart: Promise<GatewayHandle> | null = null;
/**
 * The origin the console is served from. It is not fixed: the gateway moves to
 * a new port when the port setting changes, and the window follows it.
 */
let consoleOrigin = '';

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const delay = (ms: number): Promise<null> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, ms);
  });

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

const createMainWindow = (url: string): BrowserWindow => {
  consoleOrigin = new URL(url).origin;
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

  void window.loadURL(url);

  return window;
};

/**
 * The one window the app ever opens.
 *
 * Every path that could open the console — a second launch, the dock icon, the
 * menu bar item — goes through here, so an install that is already running
 * never grows a second window or a second gateway.
 */
const showMainWindow = (): void => {
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

  if (gateway) {
    mainWindow = createMainWindow(`${gateway.url}/dashboard`);
  }
};

const statusLabel = (): string => {
  if (status === 'running' && gateway) {
    return `Running · 127.0.0.1:${gateway.port}`;
  }

  if (status === 'failed') {
    return 'Gateway failed to start';
  }

  return 'Starting gateway…';
};

const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    { enabled: false, label: `CodeBuddy2API · ${statusLabel()}` },
    { type: 'separator' },
    { click: () => showMainWindow(), label: 'Open console' },
    {
      click: () => {
        if (gateway) {
          clipboard.writeText(gateway.url);
        }
      },
      enabled: status === 'running',
      label: 'Copy local address',
    },
    { type: 'separator' },
    { click: () => app.quit(), label: 'Quit' },
  ]);

const refreshTray = (): void => {
  if (!tray) {
    return;
  }

  tray.setToolTip(`CodeBuddy2API · ${statusLabel()}`);
  tray.setContextMenu(buildTrayMenu());

  // macOS only: a short title beside the icon, so the port is readable without
  // opening the menu.
  if (process.platform === 'darwin') {
    tray.setTitle(status === 'running' && gateway ? String(gateway.port) : '…');
  }
};

/**
 * The menu bar item, which is what makes the app's state visible while the
 * console window is closed — the gateway keeps serving `/v1/*` with no window
 * open, and otherwise nothing would say so.
 */
const createTray = (): void => {
  const iconPath = path.join(__dirname, 'tray.png');

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
  if (quitting) {
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

    if (quitting) {
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
    await mainWindow.loadURL(retargetUrl(mainWindow, gateway.url)).catch(() => {
      // The window went away mid-reload; the console can be reopened from the
      // menu bar item.
    });
  }
};

/**
 * Watches the desktop settings so a port saved in the console takes effect
 * without restarting the app.
 *
 * The directory is watched rather than the file, because the file does not
 * exist until the port is changed for the first time; every other write in
 * `userData` — the database above all — is filtered out by name.
 */
const watchDesktopSettings = (): void => {
  try {
    fs.watch(userDataDir, (_event, filename) => {
      // A nameless event is not evidence that the settings changed, and a
      // restart reloads the console out from under whoever is reading it.
      if (filename !== DESKTOP_SETTINGS_FILENAME) {
        return;
      }

      scheduleRestart();
    });
  } catch {
    // Nothing to watch: a changed port then applies on the next launch.
  }
};

const bootstrap = async (): Promise<void> => {
  userDataDir = app.getPath('userData');

  createTray();
  watchDesktopSettings();

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

// A second launch would only ever start a second gateway on a second port, so
// hand the existing window back instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  // On macOS the gateway keeps serving API clients after the console window is
  // closed; elsewhere closing the window is quitting the app.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
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
