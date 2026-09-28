import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
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
import { DESKTOP_CONSOLE_COOKIE } from '../lib/server/electron/console-token';
import { findAvailablePort, probePortFree } from '../lib/server/electron/ports';
import { resolveGatewayNodePath } from '../lib/server/electron/gateway-node';
import {
  appleScriptChoice,
  appleScriptField,
  parseAppleScriptAnswer,
  parseWindowsAnswer,
  windowsEncodedCommand,
  windowsFormScript,
  zenityChoiceArgs,
  zenityFieldArgs,
  type AskAnswer,
  type AskForm,
} from '../lib/server/electron/ask';
import {
  DEVICE_REQUEST_TIMEOUT_MS,
  pollForDeviceToken,
  requestDeviceAuthorization,
  type DeviceGrant,
} from '../lib/server/electron/device-auth';
import {
  forgetDeviceToken,
  readDeviceToken,
  writeDeviceToken,
} from '../lib/server/electron/device-token';
import {
  DESKTOP_SETTINGS_FILENAME,
  MAX_PORT,
  MIN_PORT,
  defaultDesktopSettings,
  desktopSettingsPath,
  isPinnedPort,
  isValidBackendUrl,
  normalizeDesktopBackend,
  normalizeDesktopPort,
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
  HOME_PAGE_URL,
  RELEASES_PAGE_URL,
  checkForUpdate,
  type ReleaseAsset,
  type UpdateUnavailableReason,
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
/**
 * Whether a window of the app also gets a taskbar button.
 *
 * The app lives in one place: the menu bar item. Windows draws one reliably, so
 * a window opened there does not need a second place to be found in. Linux
 * desktops are too various to take the button away — a session with no tray to
 * draw the icon in would leave an open window with no way back to it — and on
 * macOS it is the Dock that goes, in `createTray`.
 */
const SKIP_TASKBAR = process.platform === 'win32';
/**
 * The menu bar icon is sixteen points, drawn at twice the pixels on a Retina
 * menu bar: an icon the size of everybody else's, and as sharp as it.
 */
const TRAY_ICON_SIZE = 16;
const TRAY_ICON_SCALE = 2;
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
/**
 * How many times the same question is put again after an answer the app cannot
 * use. Few: a dialog that keeps coming back is worse than the window, which says
 * what is wrong underneath the field as the answer is typed.
 */
const ASK_ATTEMPTS = 3;
/**
 * How much randomness is in the token the console answers to. Thirty-two bytes:
 * long enough that nothing on this machine guesses it, and it is never typed,
 * never stored, and never leaves the shell.
 */
const CONSOLE_TOKEN_BYTES = 32;

/**
 * `failed` is a gateway that stopped or never came up; `portBusy` is one the
 * app never started because the port it promised was already serving something,
 * which is the user's to settle rather than a failure to report.
 */
type GatewayStatus =
  'failed' | 'paused' | 'portBusy' | 'running' | 'starting' | 'unreachable';

/** What the window that asks about the backend can be asking. */
type BackendScreen = 'choose' | 'portInUse' | 'settings' | 'unreachable';

interface Cookie {
  name: string;
  value: string;
}

let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let backendWindow: BrowserWindow | null = null;
/** A question already on the screen: the answer is the one it is waiting for. */
let asking = false;
let tray: Tray | null = null;
let status: GatewayStatus = 'starting';
let userDataDir = '';
let restartTimer: NodeJS.Timeout | null = null;
let usageTimer: NodeJS.Timeout | null = null;
let restarting = false;
let quitting = false;
/**
 * The gateway stopped because the menu bar item said to. Not a failure, and not
 * something the app fixes on its own: a setting that changes does not start a
 * gateway the user stopped.
 */
let paused = false;
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
/**
 * The port the app wanted and could not have, because something else on this
 * machine is already serving it. Null whenever a gateway is up or was never
 * asked for: it is set only to be named to the user, in the menu and in the
 * window that asks for another one.
 */
let portBusy: number | null = null;
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
/**
 * The token the console answers to, made up for this run and handed to the
 * gateway it starts: the window carries it, and nothing else on this machine
 * does, so nothing else on this machine is shown the console.
 */
let consoleToken = '';
/**
 * The token the deployment the console shows data from handed this app, when the
 * user approved it there. Carried on everything forwarded to that deployment, so
 * the window is signed in without a password ever being typed into it — and held
 * for that address alone, because it is that deployment that promised it.
 */
let deviceToken: string | null = null;
/** Whether the app is waiting for the user to approve a device code. */
let signingIn = false;

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
 * Puts the token the console answers to where the window can send it.
 *
 * A cookie rather than a header, because the window then sends it with
 * everything it asks for — the page, the build's own assets, and every
 * `/admin-api` call the console makes — without the shell standing in the
 * middle of each one. Nothing on this machine but this window has it, which is
 * what makes the console the window's and not the address's.
 */
const setConsoleCookie = async (origin: string): Promise<void> => {
  try {
    await session.defaultSession.cookies.set({
      httpOnly: true,
      name: DESKTOP_CONSOLE_COOKIE,
      url: `${origin}/`,
      value: consoleToken,
    });
  } catch (error) {
    // Worth saying out loud rather than leaving quiet: without the cookie the
    // console answers 404 to the app's own window, which looks like a console
    // that will not come up.
    console.warn(
      `Could not hand the window its console token: ${describeError(error)}`,
    );
  }
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

  await setConsoleCookie(consoleOrigin);

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
    icon: windowIcon(),
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    // One place to find the app: the menu bar item.
    skipTaskbar: SKIP_TASKBAR,
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

  // No console to open: the gateway behind it is not up, and in both cases the
  // question the user has to settle is the one to put back in front of them.
  if (status === 'unreachable') {
    void askAboutBackend('unreachable');

    return;
  }

  if (status === 'portBusy') {
    void askAboutBackend('portInUse');
  }
};

/**
 * The port the app is asking for, which is also the one it could not have: the
 * number is what a menu item names when the gateway never started.
 */
const preferredPort = (): number =>
  resolveDesktopPreferredPort(userDataDir, process.env);

const statusLabel = (): string =>
  statusText(text(), status, {
    address: backendAddress(),
    port: String(portBusy ?? preferredPort()),
  });

/**
 * What the menu bar item says about today's usage, which is nothing at all
 * until the backend has answered: a placeholder would sit in the menu bar
 * saying nothing, and claiming zero tokens before the first answer is a number
 * the user would have to distrust.
 */
const usageLabel = (): string =>
  usageLoaded ? usageText(text(), todayUsage, locale) : '';

/**
 * The row that says whether this app is signed in to the deployment, and the one
 * that signs it in or out.
 *
 * Nothing is signed out of while a code is still waiting to be approved: the
 * token being asked for and the one being dropped are the same sign-in, and a
 * menu that offered both at once would be offering to undo what it is doing.
 */
const deviceMenu = (): MenuItemConstructorOptions => {
  const shell = text();

  if (signingIn) {
    return { enabled: false, label: shell.signingIn };
  }

  return deviceToken
    ? {
        // Named for the deployment it belongs to, because that is what was
        // signed in to — and what signing out here leaves.
        submenu: [
          { enabled: false, label: shell.signedIn },
          { click: () => void signOutOfDeployment(), label: shell.signOut },
        ],
        label: shell.signedIn,
      }
    : { click: () => void signInToDeployment(), label: shell.signIn };
};

/**
 * The menu the tray item opens: what the app is doing, the console it serves, and
 * the settings that decide both — the whole app, in the one place it is always
 * reachable from.
 */
const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    { enabled: false, label: `CodeBuddy2API · ${statusLabel()}` },
    // Nothing to say about the usage yet says so in words, not with a number.
    { enabled: false, label: usageLabel() || text().usageUnavailable },
    { type: 'separator' },
    // Starting and stopping the gateway is the one thing the menu bar item does
    // to the gateway itself, so it is the first thing in the menu.
    {
      click: () => void setPaused(status !== 'paused'),
      label: status === 'paused' ? text().resume : text().pause,
    },
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
    // The settings dialog: the backend and the port in a tab of their own,
    // beside one that says where this install keeps its data and one that says
    // what this app is.
    { click: () => void openSettings(), label: text().settings },
    // Signing in is only a question with a deployment behind the console: this
    // machine's own gateway is reachable by nothing but this app's window, which
    // needs no approval from anybody.
    ...(backend.mode === 'remote' ? [deviceMenu()] : []),
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

  // The pieces that have something to say, and no empty join between them.
  const parts = [
    // A development build says so first: on macOS the item is an alpha mask, so
    // a badge drawn into it — or the plate it sits on — is thrown away.
    ...(isDevelopmentBuild() ? ['DEV'] : []),
    'CodeBuddy2API',
    statusLabel(),
    usageLabel(),
  ].filter(Boolean);

  tray.setToolTip(parts.join(' · '));
  tray.setContextMenu(buildTrayMenu());

  // macOS only: a short title beside the icon. Today's usage is the number
  // worth having in front of you; the address is a click away — and nothing at
  // all until there is a number, because an icon with "…" beside it is an icon
  // that never says anything.
  if (process.platform === 'darwin') {
    // `DEV` there too: the mask throws away a drawn badge, and text survives.
    const development = isDevelopmentBuild();

    tray.setTitle(
      [
        development ? 'DEV' : '',
        // Stopped is the one thing worth saying instead of a number: a count
        // beside an icon that is not running is a count that stopped moving.
        status === 'paused' ? text().paused : usageLabel(),
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }
};

/**
 * The files shipped next to this bundle: the tray icons, the preload script and
 * the page that asks which backend to use.
 */
const bundleDir = (): string =>
  resolveAppBundleDir({ appPath: app.getAppPath() });

// The name scripts/dev-icon.ts exports as DEV_ICON_FILENAME, spelled out rather
// than imported from a build script this process would then carry. Whether the
// file is there is what makes a build a development one.
const devIconPath = (): string => path.join(bundleDir(), 'icon-dev.png');

const isDevelopmentBuild = (): boolean => fs.existsSync(devIconPath());

// The Dock's icon, which `electron .` has no bundle to take from and would
// otherwise be Electron's own. An install carries its icon already, so this is
// the one build that needs it drawn.
const applyDevelopmentIcon = (): void => {
  if (process.platform !== 'darwin' || app.isPackaged) {
    return;
  }

  const iconPath = devIconPath();

  if (!fs.existsSync(iconPath)) {
    return;
  }

  const icon = nativeImage.createFromPath(iconPath);

  // A file that is there but is not a PNG gives an empty image, and a dock
  // tile of nothing is worse than the one Electron would have drawn.
  if (icon.isEmpty()) {
    return;
  }

  app.dock?.setIcon(icon);
};

// Where a platform draws a window's icon at all — the title bar, the taskbar.
// macOS draws it in none of them, and there it is the Dock.
const windowIcon = (): string | undefined =>
  process.platform === 'darwin' || !isDevelopmentBuild()
    ? undefined
    : devIconPath();

/**
 * The menu bar item, which is what makes the app's state visible while the
 * console window is closed — the gateway keeps serving `/v1/*` with no window
 * open, and otherwise nothing would say so.
 */
const createTray = (): void => {
  // macOS draws a menu bar icon from its alpha channel alone and colours it
  // itself, so it gets the template: one monochrome file, right in every
  // appearance setting. Windows and Linux draw the bitmap as it is, and a
  // monochrome one disappears into a dark taskbar, so they get the app's own
  // icon, which brings its own background and reads on a light tray too.
  const template = process.platform === 'darwin';
  const development = isDevelopmentBuild();
  const iconPath =
    // Orange where the release is the app's dark, but not on macOS: there the
    // item is a mask, and an orange plate put through it comes out a light mark,
    // which is what the release already looks like.
    development && !template
      ? devIconPath()
      : path.join(bundleDir(), template ? 'tray-template.png' : 'tray.png');

  if (!fs.existsSync(iconPath)) {
    return;
  }

  // The bytes are read here rather than handed to `createFromPath`, whose own
  // file read does not go through `app.asar` — in a packaged app the icon sits
  // inside the archive next to this bundle.
  const bytes = fs.readFileSync(iconPath);
  /**
   * The icon the tray is given, at the size the platform draws it.
   *
   * macOS asks for a menu bar icon in points and draws it twice as densely on a
   * Retina display, so the pixels come from `scaleFactor`: sixteen points wide
   * holding thirty-two pixels, instead of a sixteen-pixel bitmap stretched to
   * fill them. Windows and Linux draw the pixels as they are, at one to one.
   */
  const icon = template
    ? nativeImage.createFromBuffer(bytes, {
        height: TRAY_ICON_SIZE,
        scaleFactor: TRAY_ICON_SCALE,
        width: TRAY_ICON_SIZE,
      })
    : nativeImage
        .createFromBuffer(bytes)
        .resize({ height: TRAY_ICON_SIZE, width: TRAY_ICON_SIZE });

  if (icon.isEmpty()) {
    return;
  }

  // Set last, on the image the tray is actually handed: a resize or a re-decode
  // returns a new image, and the flag — which is what makes macOS colour the
  // icon itself, white on a dark menu bar and black on a light one — belongs to
  // that one and not to the bytes it came from.
  if (template) {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);

  // On macOS a click opens the menu; elsewhere the menu is not reachable
  // without one, so the click opens the console instead.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      showMainWindow();
    });
  }

  // The dock icon stays, and that is a decision rather than an omission:
  // hiding it turns the whole process into a UIElement (accessory)
  // application, which is what macOS lets float its window over another app's
  // fullscreen Space — a console sitting in front of whatever else is on the
  // screen, with no way to put anything over it. It also takes the app out of
  // the dock and out of Cmd+Tab, so an open console could only ever be reached
  // again from the menu bar item. A development build is no exception: on macOS
  // its own icon is drawn in the Dock, which is the one place it shows.
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
      consoleToken,
      deviceToken,
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
    // The gateway is this app's own binary run as Node. On macOS it is reached
    // through a link outside the bundle, so that renaming itself — which Next
    // does as soon as it starts — cannot give it a Dock tile of its own: the
    // menu bar item is meant to be the only icon this app has.
    nodePath: resolveGatewayNodePath({
      directory: app.getPath('temp'),
      executable: process.execPath,
    }),
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
 * The port the next gateway should bind, or null when the app cannot have one
 * without asking.
 *
 * A port the app promised — one the settings file holds, or
 * `CODEBUDDY_DESKTOP_PORT` — is not its to give up: a client config, a firewall
 * rule or a bookmark points at that number, so the app asks instead of answering
 * on another one. Only a port nobody has settled walks upwards, which is what
 * keeps an install that has never been asked usable next to a deployment already
 * serving 8001.
 *
 * Probed with the gateway stopped: the one that was running still holds its
 * port, and would otherwise reject the number the app is already on — the one
 * just saved included.
 */
const resolveStartPort = async (): Promise<number | null> => {
  const preferred = preferredPort();

  if (await probePortFree(preferred)) {
    return preferred;
  }

  if (isPinnedPort(userDataDir, process.env)) {
    return null;
  }

  // Nothing free nearby is a question for the user as well, and the same one:
  // which number to move to is theirs to answer, not the app's to guess twice.
  return findAvailablePort({ preferred }).catch(() => null);
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

  // Paused is a stop the user asked for, so nothing that would start the
  // gateway — a setting saved in the console, a device signed in — starts it.
  if (paused) {
    gateway?.stop();
    gateway = null;
    status = 'paused';
    refreshTray();

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
      // The console has nothing to show yet, so what the user is asked is how to
      // get to a deployment that answers.
      void askAboutBackend('unreachable');

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

    const port = await resolveStartPort();

    // The one number the app cannot pick for the user. Asked about rather than
    // reported in an error box: it is a setting to change, not a failure of the
    // app, and the gateway keeps nothing to serve until it is.
    if (port === null) {
      portBusy = preferredPort();
      status = 'portBusy';
      refreshTray();
      void askAboutBackend('portInUse');

      return;
    }

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
    portBusy = null;
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

/**
 * Why a check could not be made, which is the one thing the dialog can still
 * say that is worth saying: "it could not be checked" on its own does not tell
 * anyone whether to look at their network or at the release page.
 */
const updateUnavailableMessage = (reason: UpdateUnavailableReason): string =>
  reason === 'no-release'
    ? text().updateNoRelease
    : reason === 'unreadable-version'
      ? text().updateUnreadableVersion
      : text().updateUnreachable;

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
        message: updateUnavailableMessage(update.reason),
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
    // where a build for another machine, or the portable one, is. So is a
    // release whose files this machine could not ask about: the page is where
    // they are either way, and "no build" is not a claim it could make.
    if (!update.asset) {
      await dialog.showMessageBox({
        message: fillText(
          update.missingAsset === 'unprobed'
            ? text().updateFilesUnreachable
            : text().updateNoBuild,
          { version: update.version },
        ),
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
 * alone. `port` is the port that window settled when it settled one, and is
 * saved along with the backend; without it, the port already on disk stands.
 *
 * Every switch goes through the bundled gateway, a deployment named or not: the
 * console is this app's own build, and the deployment only supplies the data
 * behind it.
 */
const applyBackend = async (
  next: DesktopBackend,
  { persist = false, port }: { persist?: boolean; port?: number } = {},
): Promise<void> => {
  const chosen = normalizeDesktopBackend(next);

  if (persist) {
    try {
      appliedSettings = writeDesktopSettings(userDataDir, {
        backend: chosen,
        port: port ?? readDesktopSettings(userDataDir).port,
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
  // A token is a promise one deployment made: pointed at another one, or back at
  // this machine, the app has no token at all.
  deviceToken =
    chosen.mode === 'remote' ? readDeviceToken(userDataDir, chosen.url) : null;
  todayUsage = null;
  usageLoaded = false;
  serverVersion = null;
  refreshTray();

  await restartGateway();

  if (status === 'running') {
    showMainWindow();

    return;
  }

  // A deployment that did not answer, or a port something else is already
  // serving: the window saying so is already up, and there is nothing to ask it
  // for numbers.
  if (status === 'unreachable' || status === 'portBusy') {
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
 * The port that could not be taken, for the window that says which it was and
 * asks for another.
 */
const portInUseInfo = (): { message: string; port: string } | null => {
  if (portBusy === null) {
    return null;
  }

  const port = String(portBusy);

  return { message: fillText(text().portInUseBody, { port }), port };
};

/**
 * The screen the window opens on when nothing names one: whatever the app is
 * waiting for the user to settle, and otherwise the question it always asks.
 */
const pendingScreen = (): BackendScreen =>
  status === 'portBusy'
    ? 'portInUse'
    : status === 'unreachable'
      ? 'unreachable'
      : 'choose';

/**
 * The window that asks which backend to use, and which port to serve on.
 *
 * It is a bundled page rather than a console page: it has to work before there
 * is a gateway to serve one, and it is the only thing in the app that can
 * change a setting the gateway reads to start. It is also where a deployment
 * that could not be reached, or a port that could not be taken, is reported — a
 * console of the app's own would have nothing to show for either.
 */
const openBackendWindow = ({
  screen = pendingScreen(),
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
    icon: windowIcon(),
    resizable: false,
    // One place to find the app: the menu bar item.
    skipTaskbar: SKIP_TASKBAR,
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

    // A first launch that never got its answer has nothing to fall back on, so
    // it quits: the gateway is the thing the answer decides, and starting one
    // the user did not ask for is not an answer they gave. Once a backend has
    // been chosen, closing this window leaves the app running as it was.
    if (!backendChosen) {
      app.quit();
    }
  });

  backendWindow = window;
  backendScreen = screen;

  void window.loadFile(path.join(bundleDir(), 'backend.html'));
};

/**
 * Whether the desktop is what asks, which it is unless it is told not to.
 *
 * The dialogs below are drawn by the desktop — AppKit's on macOS, a WinForms
 * form on Windows, zenity's on Linux — which is what a question the system is
 * being asked should look like: the appearance the user's desktop is in, the
 * buttons their other dialogs use, nothing of ours.
 *
 * The window above is a page of this app's, and it is reached only when it is
 * asked for by name: `CODEBUDDY_DESKTOP_ASK=window`, which is what the test
 * suite needs — a native dialog is nothing Playwright can click. A computer
 * with no dialog of its own is not answered with it: it is told so in one of
 * its own message boxes instead.
 */
const asksInSystemDialogs = (): boolean =>
  process.env.CODEBUDDY_DESKTOP_ASK?.trim() !== 'window';

/**
 * What came of asking: an answer, no answer at all, no way to ask, or a window
 * this app drew because it was told to.
 *
 * `failed` is a computer that has no dialog of its own to draw one in, or one
 * whose dialog never gave an answer the app could use. Neither is answered with
 * a page of this app's: the question is the system's to ask, and a page this app
 * draws is not the system's answer to anything. A dialog of the system's own
 * says what happened instead — `dialog.showErrorBox`, which is NSAlert, Win32
 * and GTK, not a window of ours.
 */
type AskOutcome =
  | { answer: AskAnswer; kind: 'answered' }
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  /** The desktop could not ask, so the window has to. */
  | { kind: 'window' };

interface CommandResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

/**
 * Runs the command a dialog of the system's own is asked with, and waits: a
 * dialog is modal, so this is the wait for the user's answer.
 */
const runCommand = (command: string, args: string[]): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr, stdout });
    });
  });

/**
 * The question in the dialog macOS draws.
 *
 * `osascript` is the system's own way to ask for one: `display dialog` is AppKit
 * putting it on the screen, in the appearance the desktop is in and with the
 * buttons the system uses, and it answers with the button pressed and whatever
 * was typed beside it.
 */
const askWithAppleScript = async (form: AskForm): Promise<AskAnswer | null> => {
  const options = form.options ?? [];
  let option: string | null = options[0] ?? null;

  if (options.length) {
    const { code, stdout } = await runCommand('/usr/bin/osascript', [
      '-e',
      appleScriptChoice(form),
    ]);
    const choice = parseAppleScriptAnswer(stdout);

    // Dismissed — with Esc, with the button that cancels, or by the dialog giving
    // up on its own — is not an answer.
    if (code !== 0 || choice.gaveUp || !choice.button) {
      return null;
    }

    option = choice.button;
  }

  const values: string[] = [];

  for (const field of form.fields ?? []) {
    // A field belonging to an option the user did not pick is not asked for.
    if (
      field.option !== undefined &&
      field.option !== options.indexOf(option ?? '')
    ) {
      values.push('');

      continue;
    }

    const { code, stdout } = await runCommand('/usr/bin/osascript', [
      '-e',
      appleScriptField(form, field),
    ]);
    const answer = parseAppleScriptAnswer(stdout);

    if (code !== 0 || answer.gaveUp || answer.button !== form.ok) {
      return null;
    }

    values.push(answer.text ?? '');
  }

  return { option, values };
};

/** Where Windows PowerShell is, and where it is when it is not on the PATH. */
const powershellCommands = (): [string, string] => [
  'powershell.exe',
  path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
];

/**
 * The question in a WinForms form: the framework Windows' own dialogs are
 * written in, with the radio button, the text field and the push button Windows
 * draws.
 *
 * The script travels encoded, so a question translated into Japanese, or an
 * address with an apostrophe in it, arrives exactly as it was written.
 */
const askWithWindowsForm = async (form: AskForm): Promise<AskAnswer | null> => {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-EncodedCommand',
    windowsEncodedCommand(windowsFormScript(form)),
  ];
  const [command, absolute] = powershellCommands();
  const { stdout } = await runCommand(command, args).catch(() =>
    runCommand(absolute, args),
  );
  const lines = parseWindowsAnswer(stdout);

  // A form dismissed with Cancel prints nothing at all.
  if (!lines) {
    return null;
  }

  const options = form.options ?? [];
  const [picked, ...values] = lines;

  return {
    option: options.length ? (picked ?? null) : null,
    values: options.length ? values : lines,
  };
};

/** The question in the dialog zenity draws, which is GTK's — the desktop's own. */
const askWithZenity = async (form: AskForm): Promise<AskAnswer | null> => {
  const options = form.options ?? [];
  let option: string | null = options[0] ?? null;

  if (options.length) {
    const { code, stdout } = await runCommand('zenity', zenityChoiceArgs(form));

    // Cancel in zenity is a non-zero exit.
    if (code !== 0) {
      return null;
    }

    option = stdout.trim() || option;
  }

  const values: string[] = [];

  for (const field of form.fields ?? []) {
    if (
      field.option !== undefined &&
      field.option !== options.indexOf(option ?? '')
    ) {
      values.push('');

      continue;
    }

    const { code, stdout } = await runCommand(
      'zenity',
      zenityFieldArgs(form, field),
    );

    if (code !== 0) {
      return null;
    }

    values.push(stdout.trim());
  }

  return { option, values };
};

/**
 * Puts a question to the desktop.
 *
 * `cancelled` is the user answering nothing at all. `window` is a computer with
 * no dialog of its own to ask in — no PowerShell, no zenity, one that would not
 * run — and the app's own window is then what asks.
 */
const askSystem = async (form: AskForm): Promise<AskOutcome> => {
  const ask =
    process.platform === 'darwin'
      ? askWithAppleScript
      : process.platform === 'win32'
        ? askWithWindowsForm
        : askWithZenity;

  try {
    const answer = await ask(form);

    return answer ? { answer, kind: 'answered' } : { kind: 'cancelled' };
  } catch (error) {
    // The window is what asks instead, which is not a thing to do quietly: the
    // page it shows is this app's own, and the only reason it is on screen is
    // that this computer had no dialog to draw one.
    console.warn(`The desktop could not ask: ${describeError(error)}`);

    return { kind: 'failed' };
  }
};

const invalidPortMessage = (): string =>
  fillText(text().invalidPort, {
    max: String(MAX_PORT),
    min: String(MIN_PORT),
  });

/** The two settings the app cannot start without, as one question. */
const backendForm = (error: string): AskForm => {
  const shell = text();

  return {
    cancel: shell.cancel,
    error,
    fields: [
      {
        label: shell.address,
        message: shell.backendRemoteHint,
        option: 1,
        value: backend.mode === 'remote' ? backend.url : '',
      },
      {
        // Only this machine's gateway is served on a port of this machine's: a
        // deployment is named by its address, and what it answers is reached
        // through that address rather than through a number here.
        label: shell.port,
        message: shell.portHint,
        option: 0,
        value: String(preferredPort()),
      },
    ],
    message: shell.chooseBackend,
    ok: shell.save,
    options: [shell.backendLocal, shell.backendRemote],
    title: 'CodeBuddy2API',
  };
};

/**
 * What an answer to the backend question means, whichever dialog asked it.
 *
 * An empty string when the answer could be used, and the reason it could not
 * when it could not: the same two things are asked for by the first-run
 * question and by the settings dialog, and the answer is read the same way.
 */
const applyBackendAnswer = async (
  option: string | null,
  values: string[],
): Promise<string> => {
  const [url = '', portValue = ''] = values;
  const port = normalizeDesktopPort(portValue, 0);
  const remote = option === text().backendRemote;

  if (remote && !isValidBackendUrl(url)) {
    return text().invalidBackendUrl;
  }

  // A number is asked for only with the local gateway — the dialog asks for
  // nothing else when a deployment is named, and the port the console is served
  // on then stays the one already on disk.
  if (!remote && !port) {
    return invalidPortMessage();
  }

  await applyBackend(
    normalizeDesktopBackend(
      remote ? { mode: 'remote', url } : { mode: 'local' },
    ),
    { persist: true, port: port || undefined },
  );

  return '';
};

/**
 * Which backend, and which port, asked in a dialog of the system's own.
 */
const askBackendAndPort = async (): Promise<AskOutcome['kind']> => {
  let error = '';

  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt += 1) {
    const outcome = await askSystem(backendForm(error));

    if (outcome.kind !== 'answered') {
      return outcome.kind;
    }

    error = await applyBackendAnswer(
      outcome.answer.option,
      outcome.answer.values,
    );

    if (!error) {
      return 'answered';
    }
  }

  // Never answered with a number the app could bind, in a dialog that cannot
  // say what is wrong under a field the way a window can: rather than draw one,
  // the app says so in a dialog of the system's own.
  return 'failed';
};

/**
 * Another port, asked when the one the app was given is already serving
 * something: the number is the user's to settle, not the app's to pick twice.
 */
const askPortAgain = async (): Promise<AskOutcome['kind']> => {
  const shell = text();
  const busy = portBusy ?? preferredPort();
  const free = await findAvailablePort({ preferred: busy }).catch(() => null);
  const port = String(busy);
  let error = '';

  for (let attempt = 0; attempt < ASK_ATTEMPTS; attempt += 1) {
    const outcome = await askSystem({
      cancel: shell.cancel,
      error,
      fields: [{ label: shell.port, value: String(free ?? busy) }],
      message: [
        fillText(shell.portInUseTitle, { port }),
        fillText(shell.portInUseBody, { port }),
      ].join('\n\n'),
      ok: shell.save,
      title: 'CodeBuddy2API',
    });

    if (outcome.kind !== 'answered') {
      return outcome.kind;
    }

    const next = normalizeDesktopPort(outcome.answer.values[0] ?? '', 0);

    if (!next) {
      error = invalidPortMessage();

      continue;
    }

    await applyBackend(backend, { persist: true, port: next });

    return 'answered';
  }

  return 'failed';
};

/**
 * The settings, as one window of the computer's own with the computer's tabs.
 *
 * Two tabs, and no more: the backend the app shows data from, which is the
 * question the shell used to ask on its own — which backend, which port — and
 * what this app is.
 */
/**
 * Stops the gateway, and starts it again: the one thing the menu bar item can
 * do to the gateway itself.
 *
 * A pause is not a failure and not a setting: the gateway is stopped whole, and
 * what the item says while it is stopped is that it is stopped.
 */
const setPaused = async (next: boolean): Promise<void> => {
  paused = next;

  if (paused) {
    gateway?.stop();
    gateway = null;
    status = 'paused';
    refreshTray();

    return;
  }

  await restartGateway();
};

/**
 * The settings, opened from the menu bar item.
 *
 * A window of this app's own rather than a dialog of the desktop's: what is
 * asked for is a tab view, and a script can only hand AppKit, or WinForms, or
 * zenity, a window it cannot answer for — a control drawn by a script is not
 * the control the desktop draws. The window is the one the backend question is
 * asked in, on a screen of its own.
 */
const openSettings = (): void => {
  openBackendWindow({ screen: 'settings' });
};

const deviceCodeForm = (grant: DeviceGrant): AskForm => {
  const shell = text();

  return {
    cancel: shell.cancel,
    message: fillText(shell.deviceCodeMessage, {
      code: grant.userCode,
      url: grant.verificationUri || grant.verificationUriComplete,
    }),
    ok: shell.deviceOpenBrowser,
    options: [shell.deviceOpenBrowser],
    title: 'CodeBuddy2API',
  };
};

/**
 * Signing this app in to the deployment whose data it shows.
 *
 * The app has no browser of its own to sign in in, and a passkey saved for a
 * deployment cannot be used from a window at `127.0.0.1`: a browser offers a
 * credential to the origin it is on. So the deployment is asked for two codes
 * instead — one the app waits with, one it shows — and the approval is the
 * user's to make in a browser, on the address the passkey was saved for.
 *
 * What comes back is kept on disk and handed to the gateway, which sends it with
 * everything it forwards: the window is signed in without a password ever having
 * been typed into this machine's console.
 */
const signInToDeployment = async (): Promise<void> => {
  // This machine's own gateway is served to nobody but this app's window: there
  // is no deployment to be approved by, and so no sign-in to make.
  if (backend.mode !== 'remote' || signingIn) {
    return;
  }

  const shell = text();
  // Named before anything is asked of it: the grant is that deployment's, and
  // the token that comes back is a promise it made. The backend can be pointed
  // somewhere else while the user is still approving, and a token saved under
  // the new address would be carried to a deployment that never issued it.
  const issuedBy = backend.url;
  const requested = await requestDeviceAuthorization({ baseUrl: issuedBy });

  if (requested.kind === 'notConfigured') {
    dialog.showErrorBox('CodeBuddy2API', shell.deviceNotConfigured);

    return;
  }

  if (requested.kind !== 'granted') {
    dialog.showErrorBox('CodeBuddy2API', shell.deviceSignInFailed);

    return;
  }

  const { grant } = requested;

  if (asksInSystemDialogs()) {
    const outcome = await askSystem(deviceCodeForm(grant));

    if (outcome.kind !== 'answered') {
      return;
    }
  } else {
    // Asked for by name, so it is worth saying out loud: the code is shown on the
    // page the browser opens, which is where it is typed in as well.
    console.warn(
      'CODEBUDDY_DESKTOP_ASK=window: not asking in the system’s dialog.',
    );
  }

  openExternally(grant.verificationUriComplete || grant.verificationUri);

  signingIn = true;
  refreshTray();

  try {
    const outcome = await pollForDeviceToken({
      baseUrl: issuedBy,
      deviceCode: grant.deviceCode,
      expiresIn: grant.expiresIn,
      intervalSeconds: grant.intervalSeconds,
    });

    if (outcome.kind !== 'signedIn') {
      dialog.showErrorBox(
        'CodeBuddy2API',
        outcome.kind === 'expired'
          ? shell.deviceSignInExpired
          : shell.deviceSignInFailed,
      );

      return;
    }

    // Approved by a deployment that is no longer the one behind the console:
    // the code was shown for the old address, and this token opens its door.
    // Keeping it would present one deployment's introduction to another.
    if (backend.mode !== 'remote' || backend.url !== issuedBy) {
      dialog.showErrorBox('CodeBuddy2API', shell.deviceSignInFailed);

      return;
    }

    writeDeviceToken(userDataDir, {
      token: outcome.token.accessToken,
      url: issuedBy,
    });
    deviceToken = outcome.token.accessToken;
    refreshTray();

    // Restarted because the token reaches the gateway in its environment: the
    // console the window already holds is a page that was signed out, and the one
    // it gets after this is signed in.
    await restartGateway();
  } finally {
    signingIn = false;
    refreshTray();
  }
};

/**
 * Forgetting the token: signing out here is.
 *
 * The deployment is asked to forget it too, best effort — a token this app no
 * longer holds should not still open the door it was given. Answered either way:
 * what the user asked for is that this machine stop carrying it.
 */
const signOutOfDeployment = async (): Promise<void> => {
  if (backend.mode !== 'remote') {
    return;
  }

  const url = backend.url;
  const token = deviceToken;

  deviceToken = null;
  forgetDeviceToken(userDataDir);
  refreshTray();

  if (token) {
    try {
      await fetch(`${url.trim().replace(/\/+$/, '')}/admin-api/oauth/token`, {
        headers: { authorization: `Bearer ${token}` },
        method: 'DELETE',
        signal: AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A deployment that cannot be reached cannot be told, and one that will
      // not forget is not worth failing a sign-out over: the token is gone from
      // this machine either way.
    }
  }

  await restartGateway();
};

/**
 * What to do about a deployment that did not answer, in the dialog the system
 * draws for a message: try it again, name another backend, or open the
 * deployment in the browser where its own page is.
 */
const askAboutUnreachable = async (): Promise<AskOutcome['kind']> => {
  const shell = text();
  const choice = await dialog.showMessageBox({
    // Esc answers nothing at all, which is the one answer that changes nothing.
    buttons: [
      shell.retry,
      shell.changeBackend,
      shell.openInBrowser,
      shell.cancel,
    ],
    cancelId: 3,
    defaultId: 0,
    message: unreachableInfo()?.message ?? shell.statusUnreachable,
    title: shell.unreachableTitle,
    type: 'warning',
  });

  if (choice.response === 0) {
    await restartGateway();

    return 'answered';
  }

  if (choice.response === 1) {
    return askBackendAndPort();
  }

  // Its own page, in the browser: passkeys and saved passwords are the
  // deployment's address's, not this app's.
  if (choice.response === 2 && backend.mode === 'remote') {
    openExternally(backend.url);
  }

  return 'answered';
};

/**
 * What the app says, in a dialog of the computer's own, when the computer had
 * none to ask in: the question is the system's to ask, so the reason it went
 * unasked is the system's to deliver — never a page this app drew.
 */
const couldNotAskMessage = (screen: BackendScreen): string =>
  [
    `This computer could not be asked ${
      screen === 'portInUse' ? 'which port to use' : 'which backend to use'
    }.`,
    'No dialog of its own would draw the question, and the app does not draw one of its own to ask it in.',
  ].join('\n\n');

/**
 * Puts the question the app is waiting on in front of the user.
 *
 * In a dialog of the system's own, always: AppKit's on macOS, a WinForms form on
 * Windows, the one zenity draws on Linux. `cancelled` is the user answering
 * nothing, which on a first launch is the app quitting — the gateway is what the
 * answer decides. `failed` is a computer with no dialog to ask in, or one whose
 * dialog never gave an answer the app could use: it is said in a dialog of the
 * system's own too, because a page this app draws is not the system's UI.
 */
const askAboutBackend = async (
  screen: BackendScreen = pendingScreen(),
): Promise<AskOutcome['kind']> => {
  if (asking) {
    return 'answered';
  }

  if (!asksInSystemDialogs()) {
    // Asked for by name, so it is worth saying out loud: `CODEBUDDY_DESKTOP_ASK`
    // is what turns the dialogs of the system's own off.
    console.warn(
      'CODEBUDDY_DESKTOP_ASK=window: asking in the app’s own window.',
    );

    openBackendWindow({ screen });

    return 'window';
  }

  asking = true;

  try {
    const kind =
      screen === 'portInUse'
        ? await askPortAgain()
        : screen === 'unreachable'
          ? await askAboutUnreachable()
          : await askBackendAndPort();

    if (kind === 'failed') {
      // NSAlert, Win32, GTK — the computer's own way of saying it, not a page
      // this app drew to say it in.
      dialog.showErrorBox('CodeBuddy2API', couldNotAskMessage(screen));
    }

    return kind;
  } finally {
    asking = false;
  }
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

  // A deployment that did not answer, or a port something else is already
  // serving, has a window of its own already, saying so and offering the way out
  // of it.
  if (status === 'unreachable' || status === 'portBusy') {
    return;
  }

  // Nothing to serve and no window to show: quit, unless the menu bar item can
  // report what went wrong.
  if (!tray) {
    app.quit();
  }
};

const bootstrap = async (): Promise<void> => {
  // Spelled out rather than taken from the bundle: a development build has no
  // `productName` of its own to give, and the menu bar item, the window and the
  // About tab all name the app in the same words.
  app.setName('CodeBuddy2API');
  userDataDir = app.getPath('userData');
  // Made up here and nowhere else: the gateway gets it through the environment,
  // the window gets it as a cookie, and it dies with this run — a token written
  // down would be one a next run could be made to honour.
  consoleToken = randomBytes(CONSOLE_TOKEN_BYTES).toString('hex');

  const settings = readDesktopSettings(userDataDir);
  // A settings file exists once a backend has been chosen — or once any other
  // desktop setting has been saved, which is a choice of the local gateway in
  // itself.
  const firstRun = !fs.existsSync(desktopSettingsPath(userDataDir));

  appliedSettings = settings;
  backend = settings.backend;
  backendChosen = !firstRun;
  deviceToken =
    backend.mode === 'remote'
      ? readDeviceToken(userDataDir, backend.url)
      : null;

  applyDevelopmentIcon();
  createTray();
  watchDesktopSettings();
  startUsagePolling();

  // A first launch asks before it starts anything: the answer decides whether a
  // gateway is even needed. Answered with nothing at all, it quits — the gateway
  // is the thing the answer decides, and starting one the user did not ask for is
  // not an answer they gave.
  if (firstRun) {
    const kind = await askAboutBackend('choose');

    // No answer, and no dialog that could have carried one: either way the app
    // has no gateway to start, and a first launch is not a menu bar item
    // waiting for an answer nobody asked for.
    if (kind === 'cancelled' || kind === 'failed') {
      app.quit();
    }

    return;
  }

  await startBackend();
};

/**
 * Everything the window that asks knows: what the app is asking about, the two
 * settings it can settle — the backend and the port — and why either might not
 * have been the app's to accept.
 */
ipcMain.handle('desktop:info', () => ({
  appVersion: app.getVersion(),
  backend,
  /** A first launch has no answer on disk, and closing it quits the app. */
  firstRun: !backendChosen,
  homePage: HOME_PAGE_URL,
  locale,
  // The bounds the field is checked against are the main process's: it is the
  // half that refuses a port outside them.
  maxPort: MAX_PORT,
  minPort: MIN_PORT,
  port: preferredPort(),
  portInUse: portInUseInfo(),
  screen: backendScreen,
  serverVersion,
  text: text(),
  unreachable: unreachableInfo(),
}));

/**
 * Saves what the window settled: which backend, and which port to serve on.
 */
ipcMain.handle('desktop:set-backend', (_event, next: unknown) => {
  const window = backendWindow;
  const record =
    next && typeof next === 'object' && !Array.isArray(next)
      ? (next as { backend?: unknown; port?: unknown })
      : {};

  // Normalized here, at the boundary a page can reach: the window has no say in
  // what counts as a backend or as a port.
  const port = normalizeDesktopPort(record.port, 0);

  void applyBackend(normalizeDesktopBackend(record.backend), {
    persist: true,
    // A port the page did not settle — one it never showed, or one left blank —
    // leaves the one on disk standing.
    port: port || undefined,
  });
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
 * Asks again, for the window that reported a deployment unreachable or a port
 * taken: a deployment that was merely cold, a network that came back, or a port
 * freed while the window was open, is all fixed by asking once more rather than
 * by retyping anything.
 *
 * The answer is awaited by the page, which is what lets it say it is trying.
 */
ipcMain.handle('desktop:retry-backend', async () => {
  const window = backendWindow;

  await restartGateway();

  // Answered this time: the question goes away and the console comes up.
  if (status === 'running') {
    window?.close();
    showMainWindow();
  }
});

/**
 * Where this app lives, in the system browser: the window is a window of the
 * app's, and a page about the app is not one it should navigate itself to.
 */
ipcMain.handle('desktop:open-home-page', () => {
  openExternally(HOME_PAGE_URL);
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
