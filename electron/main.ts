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
  defaultDesktopSettings,
  desktopSettingsPath,
  isPinnedPort,
  normalizeDesktopBackend,
  readDesktopSettings,
  resolveDesktopPreferredPort,
  writeDesktopSettings,
  type DesktopBackend,
  type DesktopSettings,
} from '../lib/server/electron/settings';
import {
  desktopText,
  fillText,
  statusText,
  usageText,
  type DesktopText,
} from '../lib/server/electron/desktop-text';
import {
  adminCookieHeader,
  fetchTodayUsage,
  type DesktopUsage,
} from '../lib/server/electron/usage';
import {
  probeDeployment,
  type DeploymentProbe,
} from '../lib/server/electron/deployment';
import {
  RELEASES_PAGE_URL,
  checkForUpdate,
  type ReleaseAsset,
} from '../lib/server/electron/updates';
import { fetchServerVersion } from '../lib/server/electron/version';

const WINDOW_HEIGHT = 880;
const WINDOW_WIDTH = 1360;
const MIN_WINDOW_HEIGHT = 640;
const MIN_WINDOW_WIDTH = 960;
/**
 * The window that asks about the backend is sized to what it is asking: the page
 * measures its own text and the window follows, which is the only way a question
 * translated into three languages — on a computer that picked its own font —
 * comes out the size it should be. These are the bounds it is never allowed to
 * leave, and the size it starts at before the page has measured itself.
 */
const BACKEND_WINDOW_MAX_HEIGHT = 720;
const BACKEND_WINDOW_MAX_WIDTH = 720;
const BACKEND_WINDOW_MIN_HEIGHT = 180;
const BACKEND_WINDOW_MIN_WIDTH = 320;
const BACKEND_WINDOW_HEIGHT = 320;
const BACKEND_WINDOW_WIDTH = 480;
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
 * How long the console is given to load before the shell sends the window there
 * again. Generous: a real first render is expected to beat it, so the second
 * attempt is only ever reached by a load that has stopped making progress.
 */
const CONSOLE_LOAD_TIMEOUT_MS = 10_000;
/**
 * How long the installer download gets. Long enough for a slow connection and
 * a disk image over a hundred megabytes; not unlimited, because a server that
 * accepts the request and then stalls would otherwise leave the menu item
 * saying "Downloading…" until the app is restarted.
 */
const INSTALLER_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

type GatewayStatus = 'failed' | 'running' | 'starting' | 'unreachable';

/** What the window that asks about the backend can be asking. */
type BackendScreen = 'choose' | 'unreachable';

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
 * The origin the console is served from, which is the bundled gateway's: the
 * pages are this app's own whether a deployment is configured or not. It still
 * moves — the gateway takes a new port when the port setting changes.
 */
let consoleOrigin = '';
/**
 * Where the console's data comes from: the gateway bundled into the app, or a
 * deployment the user already runs, which the gateway forwards to. Everything
 * else follows from it.
 */
let backend: DesktopBackend = { mode: 'local' };
/** Today's token counts, once a backend has answered. */
let todayUsage: DesktopUsage | null = null;
let usageLoaded = false;
/**
 * The version of the deployment serving the console, when it is not this app:
 * a remote backend is a build of its own. Null for the bundled gateway, which
 * is the app, and for a deployment that has not answered yet.
 */
let serverVersion: string | null = null;
/**
 * Why the deployment the user named could not be used. Kept so the window that
 * reports it can say which it was: nothing answered, or something that is not
 * this app.
 */
let lastProbe: DeploymentProbe | null = null;
/** What the window that asks about the backend is currently asking. */
let backendScreen: BackendScreen = 'choose';
/** What an update check is doing, which the menu item reports. */
let updateState: 'checking' | 'downloading' | 'idle' = 'idle';
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
 *
 * Always the bundled gateway's, a deployment configured or not: what the window
 * shows is this app's own console, and only the data behind `/admin-api` comes
 * from the deployment.
 */
const consoleBaseUrl = (): string => gateway?.url ?? '';

/** The loopback address the bundled gateway is on, or `…` until it is up. */
const backendAddress = (): string =>
  gateway ? `127.0.0.1:${gateway.port}` : '…';

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
 * Sends a window to the console, keeping the navigation allow-list in step with
 * where it is going.
 */
const loadConsole = async (
  window: BrowserWindow,
  url: string,
): Promise<void> => {
  consoleOrigin = new URL(url).origin;

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

    return;
  }

  // No console to open, because the deployment that would fill it never
  // answered: the window that says so is the one to bring back.
  if (status === 'unreachable') {
    openBackendWindow({ screen: 'unreachable' });
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
    {
      enabled: false,
      label: fillText(text().appVersion, { version: app.getVersion() }),
    },
    // Only a backend that is not this app has a version of its own to name.
    ...(serverVersion
      ? [
          {
            enabled: false,
            label: fillText(text().serverVersion, { version: serverVersion }),
          },
        ]
      : []),
    {
      click: () => void runUpdateCheck(),
      enabled: updateState === 'idle',
      label: updateMenuLabel(),
    },
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

const launchGateway = async (
  port: number,
  upstream: string | null,
): Promise<GatewayHandle> => {
  const paths = resolveDesktopPaths(userDataDir);

  ensureDesktopDirectories(paths);

  return startGateway({
    env: buildGatewayEnv({
      encryptionKey: ensureDesktopEncryptionKey(paths.keyFile),
      paths,
      port,
      // The console is served here either way; with a deployment named, this
      // only tells it where to forward `/admin-api` and `/v1`.
      upstream,
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
 *
 * The gateway runs either way: it is what serves the console. A deployment only
 * decides where the data behind it comes from, so it is asked first — a console
 * pointed at a deployment that is not there would otherwise come up quiet and
 * empty, and look like the app's own failure.
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

  const startedFor = backend;
  const upstream = backend.mode === 'remote' ? backend.url : null;

  if (upstream) {
    lastProbe = await probeDeployment({ url: upstream });

    if (lastProbe.kind !== 'ready') {
      restarting = false;
      gateway?.stop();
      gateway = null;
      status = 'unreachable';
      refreshTray();
      // The console has nothing to show yet, so the window that names the
      // deployment is the one to put in front of the user.
      openBackendWindow({ screen: 'unreachable' });

      return;
    }
  } else {
    lastProbe = null;
  }

  try {
    // The gateway that is running still holds its port, so probing before
    // stopping it would reject the port the app is already on — the one just
    // saved included — and settle on the next one instead. Release it first.
    gateway?.stop();
    gateway = null;

    const port = await findAvailablePort({
      // One attempt when the port was named — the environment, or the port the
      // console saved: something outside the app points at that number, so the
      // app takes it or says it cannot, rather than answering on another one.
      // Left at the default, it walks upwards instead, which is what keeps the
      // app usable next to a deployment already serving 8001.
      attempts: isPinnedPort(userDataDir, process.env) ? 1 : undefined,
      preferred: resolveDesktopPreferredPort(userDataDir, process.env),
    });

    pendingStart = launchGateway(port, upstream);
    gateway = await pendingStart;
    pendingStart = null;

    // The port probe and the health check take seconds, and the backend can
    // change meanwhile — give this gateway back instead of steering the console
    // to a build started for a backend the app has already walked away from.
    if (quitting || !sameBackend(backend, startedFor)) {
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

  // Only worth asking a backend that is not this app: the gateway the app
  // starts is the app, and its version is the one the menu already names.
  serverVersion =
    backend.mode === 'remote'
      ? await fetchServerVersion({
          baseUrl,
          cookie: adminCookieHeader(cookies),
        })
      : null;

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
 * What the update item says. It names what it is doing while it is doing it,
 * because a menu that still looks idle during a download is a menu that gets
 * clicked twice.
 */
const updateMenuLabel = (): string =>
  updateState === 'checking'
    ? text().updateChecking
    : updateState === 'downloading'
      ? text().updateDownloading
      : text().checkForUpdates;

/** The installer for a newer release, downloaded to a temporary file. */
const downloadInstaller = async (asset: ReleaseAsset): Promise<string> => {
  const target = path.join(app.getPath('temp'), asset.name);
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(INSTALLER_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${asset.name}`);
  }

  await fs.promises.writeFile(
    target,
    Buffer.from(await response.arrayBuffer()),
  );

  // An AppImage is the program, so it needs to be executable; a Windows
  // installer inherits its permissions from the file system it lands on.
  if (process.platform !== 'win32') {
    await fs.promises.chmod(target, 0o755);
  }

  return target;
};

/**
 * Puts a downloaded AppImage where the running one is.
 *
 * An AppImage is the program, so an update means replacing the file, not
 * opening the download: opening it would run a second copy of the app, which
 * finds the single-instance lock, quits, and hands the window straight back to
 * the old build — and even without the lock the new file would sit in a
 * temporary directory and be gone by the next reboot.
 *
 * The copy lands beside the running file and is renamed over it, so a failed
 * download or a read-only directory leaves the installed AppImage as it was.
 * Nothing to replace means nothing was started from an AppImage — a distro
 * package, or an unpacked directory — and the caller says where the file went
 * instead.
 */
const replaceAppImage = async (downloaded: string): Promise<boolean> => {
  const current = process.env.APPIMAGE?.trim();

  if (!current) {
    return false;
  }

  const staged = `${current}.new`;

  try {
    await fs.promises.copyFile(downloaded, staged);
    await fs.promises.rename(staged, current);
    // Relaunched before it quits: the file it starts is the one just written.
    app.relaunch();
    app.exit(0);
  } catch (error) {
    await fs.promises.rm(staged, { force: true });
    dialog.showErrorBox(
      'CodeBuddy2API',
      `${text().updateFailed}\n\n${describeError(error)}`,
    );

    return false;
  }

  return true;
};

/**
 * Whether a newer release exists, and — if the user wants it — the build for
 * this machine, handed to the platform to install: an installer that runs, a
 * disk image that mounts.
 *
 * The step that replaces the app is the one the user agrees to. Nothing is
 * downloaded before that, and nothing is replaced behind their back: what runs
 * is the installer they would have downloaded themselves.
 */
const runUpdateCheck = async (): Promise<void> => {
  if (updateState !== 'idle') {
    return;
  }

  updateState = 'checking';
  refreshTray();

  try {
    const current = app.getVersion();
    const update = await checkForUpdate({ currentVersion: current });

    if (update.kind === 'unavailable') {
      await dialog.showMessageBox({
        message: text().updateFailed,
        title: 'CodeBuddy2API',
      });

      return;
    }

    if (update.kind === 'up-to-date') {
      await dialog.showMessageBox({
        message: fillText(text().updateUpToDate, {
          version: update.version,
        }),
        title: 'CodeBuddy2API',
      });

      return;
    }

    // Newer, but not for this platform and architecture: the release page is
    // where a build for another machine, or the portable one, is.
    if (!update.asset) {
      await dialog.showMessageBox({
        message: fillText(text().updateNoBuild, { version: update.version }),
        title: 'CodeBuddy2API',
      });
      await shell.openExternal(RELEASES_PAGE_URL);

      return;
    }

    const choice = await dialog.showMessageBox({
      buttons: [text().updateInstall, text().updateLater],
      cancelId: 1,
      defaultId: 0,
      message: fillText(text().updateAvailableBody, {
        current,
        version: update.version,
      }),
      title: text().updateAvailableTitle,
    });

    if (choice.response !== 0) {
      return;
    }

    updateState = 'downloading';
    refreshTray();

    const installer = await downloadInstaller(update.asset);

    // A disk image mounts and a setup program runs, and both are what opening
    // the file is for. An AppImage has to be put where the running one is
    // instead, or the "Install" button installs nothing.
    if (process.platform === 'linux' && installer.endsWith('.AppImage')) {
      if (!(await replaceAppImage(installer))) {
        shell.showItemInFolder(installer);
      }

      return;
    }

    const notOpened = await shell.openPath(installer);

    // The download happened either way, so show where it went instead of
    // leaving an installer the user cannot find.
    if (notOpened) {
      shell.showItemInFolder(installer);
    }
  } catch (error) {
    dialog.showErrorBox(
      'CodeBuddy2API',
      `${text().updateFailed}\n\n${describeError(error)}`,
    );
  } finally {
    updateState = 'idle';
    refreshTray();
  }
};

/**
 * Switches the app to a backend and reopens the console on it.
 *
 * `persist` is set when the choice came from the window that asks: the settings
 * file is then the record of the choice, and the watcher leaves that write
 * alone.
 *
 * Every switch goes through the bundled gateway, a deployment named or not: the
 * console is this app's own build, and the deployment only supplies the data
 * behind it.
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
  serverVersion = null;
  refreshTray();

  await restartGateway();

  if (status === 'running') {
    showMainWindow();

    return;
  }

  // A deployment that did not answer: the window saying so is already up, and
  // there is nothing to ask it for numbers.
  if (status === 'unreachable') {
    return;
  }

  // Nothing to serve and no window to show: quit, unless the menu bar item can
  // report what went wrong.
  if (!tray) {
    app.quit();
  }
};

/**
 * Why the deployment in the settings could not be used, for the window that
 * reports it: which host, and which of the two ways it failed.
 */
const unreachableInfo = (): { host: string; message: string } | null => {
  if (!lastProbe || lastProbe.kind === 'ready' || backend.mode !== 'remote') {
    return null;
  }

  const host = new URL(backend.url).host;

  return {
    host,
    message: fillText(
      lastProbe.kind === 'foreign'
        ? text().unreachableBodyForeign
        : text().unreachableBodyUnreachable,
      { host },
    ),
  };
};

/**
 * The window that asks which backend to use.
 *
 * It is a bundled page rather than a console page: it has to work before there
 * is a gateway to serve one, and it is the only thing in the app that can
 * change a setting the gateway reads to start. It is also where a deployment
 * that could not be reached is reported — a console of the app's own would have
 * nothing to show for it.
 */
const openBackendWindow = ({
  screen = 'choose',
}: { screen?: BackendScreen } = {}): void => {
  if (backendWindow) {
    if (backendWindow.isDestroyed()) {
      backendWindow = null;
    } else {
      // Asking something else already: send it to what matters now.
      if (backendScreen !== screen) {
        backendScreen = screen;
        void backendWindow.loadFile(path.join(bundleDir(), 'backend.html'));
      }

      backendWindow.focus();

      return;
    }
  }

  const window = new BrowserWindow({
    autoHideMenuBar: true,
    height: BACKEND_WINDOW_HEIGHT,
    resizable: false,
    title: 'CodeBuddy2API',
    // The page measures itself and asks for the size it needs, so these numbers
    // are the page's own and not the window around it.
    useContentSize: true,
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
  backendScreen = screen;

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
  // A deployment configured or not, this starts the gateway that serves the
  // console; the deployment only decides where its data comes from.
  await restartGateway();

  if (status === 'running') {
    showMainWindow();

    return;
  }

  // A deployment that did not answer has a window of its own already, saying so
  // and offering the way out of it.
  if (status === 'unreachable') {
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
  screen: backendScreen,
  text: text(),
  unreachable: unreachableInfo(),
}));

ipcMain.handle('desktop:set-backend', (_event, next: unknown) => {
  const window = backendWindow;

  // Normalized here, at the boundary a page can reach: the window has no say in
  // what counts as a backend.
  void applyBackend(normalizeDesktopBackend(next), { persist: true });
  window?.close();
});

/**
 * Sizes the window that asks about the backend to the question it is asking.
 *
 * The page measures its own pane and asks through the bridge: the strings are
 * this process's own, but only a rendered page knows how much room they took in
 * the font this computer actually has. Only this window is resized, only within
 * the bounds above, and only when the size really changed — a page's own layout
 * is not something that gets to walk the window anywhere it likes.
 */
ipcMain.handle(
  'desktop:set-content-size',
  (event, width: unknown, height: unknown) => {
    const window = backendWindow;

    if (!window || window.isDestroyed()) {
      return;
    }

    // A size from any other page is not one to honour.
    if (window.webContents.id !== event.sender.id) {
      return;
    }

    const clamp = (value: unknown, min: number, max: number): number => {
      const size =
        typeof value === 'number' && Number.isFinite(value) ? value : min;

      return Math.round(Math.min(Math.max(size, min), max));
    };
    const nextWidth = clamp(
      width,
      BACKEND_WINDOW_MIN_WIDTH,
      BACKEND_WINDOW_MAX_WIDTH,
    );
    const nextHeight = clamp(
      height,
      BACKEND_WINDOW_MIN_HEIGHT,
      BACKEND_WINDOW_MAX_HEIGHT,
    );
    const [currentWidth, currentHeight] = window.getContentSize();

    if (currentWidth === nextWidth && currentHeight === nextHeight) {
      return;
    }

    window.setContentSize(nextWidth, nextHeight);
  },
);

/**
 * Asks the deployment again, for the window that reported it unreachable: a
 * deployment that was merely cold, or a network that came back, is fixed by
 * asking once more rather than by retyping the address.
 */
ipcMain.handle('desktop:retry-backend', () => {
  const window = backendWindow;

  void (async () => {
    await restartGateway();

    // Answered this time: the question goes away and the console comes up.
    if (status === 'running') {
      window?.close();
      showMainWindow();
    }
  })();
});

/** The deployment itself, in the system browser: the app's window is not one. */
ipcMain.handle('desktop:open-in-browser', () => {
  if (backend.mode === 'remote') {
    openExternally(backend.url);
  }
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
