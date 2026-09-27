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

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const createMainWindow = (url: string): BrowserWindow => {
  const origin = new URL(url).origin;
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
    void shell.openExternal(target);

    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(origin)) {
      return;
    }

    event.preventDefault();
    void shell.openExternal(target);
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
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.focus();

    return;
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

  const icon = nativeImage.createFromPath(iconPath);

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
  if (restarting) {
    scheduleRestart();

    return;
  }

  restarting = true;
  status = 'starting';
  refreshTray();

  try {
    const port = await findAvailablePort({
      preferred: resolveDesktopPreferredPort(userDataDir, process.env),
    });

    gateway?.stop();
    gateway = null;
    gateway = await launchGateway(port);
    status = 'running';
    refreshTray();

    // The console is served by the gateway, so it has to follow it.
    if (mainWindow) {
      await mainWindow.loadURL(`${gateway.url}/dashboard`);
    }
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
      if (filename && filename !== DESKTOP_SETTINGS_FILENAME) {
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

  app.on('before-quit', () => {
    gateway?.stop();
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
