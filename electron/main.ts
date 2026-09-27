import { BrowserWindow, app, dialog, shell } from 'electron';

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
import {
  findAvailablePort,
  resolvePreferredPort,
} from '../lib/server/electron/ports';

const WINDOW_HEIGHT = 880;
const WINDOW_WIDTH = 1360;
const MIN_WINDOW_HEIGHT = 640;
const MIN_WINDOW_WIDTH = 960;

let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;

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

const bootstrap = async (): Promise<void> => {
  const paths = resolveDesktopPaths(app.getPath('userData'));

  ensureDesktopDirectories(paths);

  const port = await findAvailablePort({
    preferred: resolvePreferredPort(process.env),
  });

  gateway = await startGateway({
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

  mainWindow = createMainWindow(`${gateway.url}/dashboard`);
};

const focusMainWindow = (): void => {
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

// A second launch would only ever start a second gateway on a second port, so
// hand the existing window back instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  // On macOS the gateway keeps serving API clients after the console window is
  // closed; elsewhere closing the window is quitting the app.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    focusMainWindow();
  });

  app.on('before-quit', () => {
    gateway?.stop();
  });

  void app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      gateway?.stop();
      dialog.showErrorBox(
        'CodeBuddy2API',
        `The local gateway failed to start.\n\n${describeError(error)}`,
      );
      app.quit();
    }
  });
}
