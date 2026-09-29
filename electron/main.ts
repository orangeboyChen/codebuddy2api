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
  nativeTheme,
  session,
  shell,
} from 'electron';

import { askingOneAtATime } from './asking';
import { closeWindow } from './window';

import {
  localeCookieName,
  localePreferenceCookieName,
} from '../lib/i18n/cookie-names';
import {
  parseThemeMode,
  resolvedThemeCookieName,
  themeCookieName,
} from '../lib/theme';
import {
  buildGatewayEnv,
  startGateway,
  type GatewayHandle,
  type GatewayProcess,
  type GatewaySpawn,
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
  requestDeviceAuthorization,
  startDeviceRedirectListener,
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
import { fetchUpstreamSessionSummary } from '../lib/server/admin/upstream';

/** Every window of the app's own carries this title, and never another. */
const APP_TITLE = 'CodeBuddy2API';

/**
 * The app's name, set before `ready` and before anything reads it.
 *
 * A development build — `electron .` — has no bundle to take a `productName`
 * from, so the menu, the window and the About tab would all call this process
 * "Electron". Named at module scope rather than in `bootstrap`, because the
 * application menu is built from it and a name set later is a menu that was
 * already written.
 */
app.setName(APP_TITLE);

/**
 * What the About panel says.
 *
 * Set because the panel is otherwise the bundle's: on macOS it takes its name,
 * its version and its icon from the app's `.plist`, and a development build —
 * `electron .` — has no bundle of its own to take them from, so what it shows
 * is Electron's. `app.setName` above is no help here: it "does not affect the
 * name that the OS uses".
 *
 * The icon is the one thing this cannot fix on macOS: `iconPath` is answered on
 * Linux and Windows only, and a macOS About panel keeps the bundle's picture —
 * which is the last reason development runs the app as a bundle of its own
 * rather than as `electron .`.
 */
app.setAboutPanelOptions({
  applicationName: APP_TITLE,
  applicationVersion: app.getVersion(),
});

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
 * The colour the console is drawn in, which is what a window of this app is
 * painted behind the page in it.
 *
 * The console's own two, taken from `--lobe-color-bg-layout` in
 * `app/globals.scss`: a window that comes up in a colour the page is about to
 * paint over is a flash of the one thing on the screen that is not the console.
 */
const CONSOLE_BACKGROUND: Record<'dark' | 'light', string> = {
  dark: '#111318',
  light: '#f7f7f8',
};
/**
 * No colour at all, which is what a window drawn on the desktop's own blur
 * needs.
 *
 * The material is made from what is behind the window, and a background of the
 * window's own is part of the window: painted in, it is the flat colour the
 * blur is taken of, and the frost is a pane of `#16161a` instead. Which is why
 * a macOS window asks for none — and why the vibrancy looked like it had never
 * been asked for at all.
 */
const TRANSPARENT_WINDOW_BACKGROUND = '#00000000';
/**
 * On macOS the window is drawn on the desktop's own blur, behind the page, the
 * way every other window there is. Nowhere else: Windows and Linux paint a
 * window's background themselves and have no such material to hand.
 */
const WINDOW_VIBRANCY = 'under-window';
/**
 * A picture in the console is not a thing to be dragged.
 *
 * Dragging one out of a window that is not a browser drops a file nobody asked
 * for, or navigates to `file://` — and either reads as the window misbehaving.
 * The console is read and clicked, so what is in it is too.
 */
const NO_IMAGE_DRAG_CSS = 'img { -webkit-user-drag: none; }';
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
 * How long a restart waits for the gateway it just stopped to let go of its
 * port. `stop()` is a signal and not an exit, and a process that has been
 * signalled keeps answering for a moment: long enough for the probe below to
 * find this app's own gateway still serving, and to report the port the app is
 * already on as taken by somebody else.
 */
const GATEWAY_EXIT_GRACE_MS = 2_000;
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
/**
 * Whether the window that just closed was the one that asks about the backend.
 *
 * On Windows and Linux this app quits when it has no windows left — which is
 * right for the console, and wrong for the question: that window is opened from
 * the menu bar item to be looked at and closed again, while the app goes on in
 * the tray. Asked about in `window-all-closed`, `backendWindow` is already
 * `null`, because the window's own `closed` has run by then — so it is
 * remembered here instead.
 */
let backendWindowWasLast = false;
/**
 * The question about the backend: one at a time, and the one its answer raised.
 *
 * Declared before the ask it is given, because that is where a question raised
 * by an answer comes back to: `askAboutBackend` is what a question reaches the
 * user through.
 */
const backendQuestions = askingOneAtATime<BackendScreen>((screen) => {
  void askAboutBackend(screen);
});
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
 * The process of a gateway that is still coming up.
 *
 * A start that has not landed has no handle to stop, and it is the process —
 * not the handle — that holds the port: an app that quits while the gateway is
 * starting would leave the child behind, and the next launch would find the
 * port taken by this app's own gateway from last time.
 */
let pendingChild: GatewayProcess | null = null;
/**
 * A console somebody asked for while there was none to open.
 *
 * The click that asks for it — the menu bar item, the Dock, a second launch —
 * can land while the gateway is still coming up. It is kept rather than
 * dropped, and answered by the start that is already under way.
 */
let consoleRequestPending = false;
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
/** The appearance the console is showing, which the menu bar item can change. */
let consoleTheme: 'dark' | 'light' | 'system' = 'system';
/**
 * The language the console is showing, and `system` for one that follows the
 * request: the choice the menu bar item offers is the one already made.
 */
let consoleLocalePreference = 'system';
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

/**
 * Loads a bundled page into a window, and says so when it cannot be loaded.
 *
 * `loadFile` answers with a promise that rejects: when the page is not in the
 * bundle, and when the window goes away before the load lands — which is a
 * window the user closed, not something this app failed at. Neither is worth
 * crashing over, but a rejection nobody is waiting for is an unhandled one,
 * and an unhandled rejection is not a warning this app chose to print.
 */
const loadBundledPage = (window: BrowserWindow, file: string): void => {
  void window.loadFile(file).catch((error: unknown) => {
    console.warn(`Could not load ${file}: ${describeError(error)}`);
  });
};

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

    // Rejects on a computer that has nothing to open a URL with — no handler
    // for it, no desktop session behind it. A rejection nobody is waiting for
    // is not a warning this app chose to print, and a link the user clicked is
    // not something to crash over.
    void shell.openExternal(parsed.href).catch((error: unknown) => {
      console.warn(`Could not open ${parsed.href}: ${describeError(error)}`);
    });
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
    // The cookie above is awaited, and the attempt below is given ten seconds:
    // both are long enough for the window to be closed by the user, and
    // `loadURL` on a window that has gone throws rather than answers — a throw
    // that is not a failed load, and would take the console's opening down with
    // it on its way out. Nothing to load into, so nothing to wait for.
    if (window.isDestroyed()) {
      return;
    }

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

/**
 * Takes dragging away from the pictures in a window, on every page that loads
 * in it — a stylesheet is what survives a navigation, and the console is a page
 * that navigates.
 */
const stopImageDragging = (window: BrowserWindow): void => {
  window.webContents.on('did-finish-load', () => {
    // The window can be closed between the page finishing its load and this
    // landing, and `insertCSS` rejects on a window that has gone — a rejection
    // nobody is waiting for, for a window nobody is looking at.
    void window.webContents
      .insertCSS(NO_IMAGE_DRAG_CSS)
      .catch((error: unknown) => {
        console.warn(
          `Could not keep pictures from being dragged: ${describeError(error)}`,
        );
      });
  });
};

/**
 * Keeps the app's own name on a window rather than the page's.
 *
 * The console rewrites the document's title on its way between tabs, and there
 * is a moment in the middle of the move with no title at all — which took the
 * name off the window and put it back, a blink on every switch. Every window
 * of this app carries the same title and never another, so the page is not the
 * one worth asking.
 */
const keepWindowTitle = (window: BrowserWindow): void => {
  window.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  window.setTitle(APP_TITLE);
};

const createMainWindow = (url: string): BrowserWindow => {
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    height: WINDOW_HEIGHT,
    icon: windowIcon(),
    minHeight: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    // One place to find the app: the menu bar item.
    skipTaskbar: SKIP_TASKBAR,
    show: false,
    title: APP_TITLE,
    // macOS only: the frost behind the page. Everywhere else a window is
    // painted by the desktop and there is nothing to put behind it.
    ...(process.platform === 'darwin'
      ? { vibrancy: WINDOW_VIBRANCY }
      : undefined),
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
    backendWindowWasLast = false;
  });

  stopImageDragging(window);
  keepWindowTitle(window);

  void loadConsole(window, url);

  return window;
};

/**
 * Asks before opening the console of a gateway that is stopped.
 *
 * There is nothing to show while nothing is serving the console, so the click
 * used to answer with nothing at all — and a button that does nothing is a
 * button that reads as broken. Starting the gateway is what was meant by it,
 * so starting it is what is offered.
 */
const askToStartPausedGateway = async (): Promise<void> => {
  const shell = text();
  const { response } = await dialog.showMessageBox({
    buttons: [shell.resume, shell.cancel],
    cancelId: 1,
    defaultId: 0,
    message: shell.pausedOpenConsole,
    title: APP_TITLE,
  });

  if (response !== 0) {
    return;
  }

  // Opened after the gateway is up and not before: a window made now would load
  // a console nobody is serving, and land on an error instead of the console.
  await setPaused(false);
  showMainWindow();
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

  // A paused gateway is one the window can be reopened for, but not one that is
  // serving anything to put in it — so the click is answered with the question
  // rather than with a window that says the console is gone.
  if (status === 'paused') {
    void askToStartPausedGateway();

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

  // No console to open: the gateway behind it is not up. What is put in front
  // of the user is the question they can settle — which backend, which port —
  // and raised rather than asked, because this can be reached from inside an
  // answer being applied, where an ask is one the guard would refuse.
  if (status === 'unreachable') {
    raiseBackendQuestion('unreachable');

    return;
  }

  if (status === 'portBusy') {
    raiseBackendQuestion('portInUse');

    return;
  }

  // A gateway that failed to start is this app's own failure, already put in
  // front of the user in a dialog of the computer's own when it happened — and
  // not a question they can settle here. What they asked for is a console,
  // whether by clicking the menu bar item or by answering "Resume"; the only
  // way to one is a gateway that starts, and a port freed since, or a
  // deployment that has come back, is answered by trying again. Left as it
  // was, the click did nothing at all, which is what reads as broken.
  //
  // Remembered the way a click made during a start is, so the try is what
  // opens the console it was asked for — and forgets the click if there is
  // still none to open.
  consoleRequestPending = true;

  // A start already running is the one that answers this: the click waits for
  // it rather than scheduling a second one behind it, which would stop the
  // gateway it is bringing up and start it again.
  if (restarting) {
    return;
  }

  void restartGateway();
};

/**
 * Opens the console because somebody asked for it — a click on the menu bar
 * item, on the Dock, on a second launch — rather than because a restart of the
 * gateway just succeeded.
 *
 * Every one of those is a click on a paused gateway too, and a paused gateway
 * has no console to open: what is meant by the click is starting it, so that is
 * what is offered instead of a window that would load nothing.
 */
const openConsoleOnRequest = (): void => {
  if (status === 'paused') {
    void askToStartPausedGateway();

    return;
  }

  // The gateway is on its way up and there is no console to open yet — but
  // there will be in a second or two, and a click that does nothing at all is
  // a click the user makes again, or reads as a broken app. Remembered, and
  // answered by the restart that is already running.
  if (status === 'starting') {
    consoleRequestPending = true;

    return;
  }

  showMainWindow();
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
  // Counts belong to a gateway that is serving them: a gateway that has been
  // paused, or has died, or has been handed back because the backend changed
  // underneath it, has no today to report — and a menu that keeps saying it
  // disagrees with the title above it, which says the gateway is gone.
  usageLoaded && gateway ? usageText(text(), todayUsage, locale) : '';

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
 * The languages the console speaks, each named in itself: a language is not
 * translated, so these read the same in every locale the menu bar item has.
 *
 * The three `lib/i18n/routing` offers, spelled out because that module carries
 * next-intl with it and the main process has no use for one.
 */
const LOCALE_MENU_ITEMS: Array<{ label: string; value: string }> = [
  { label: '简体中文', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
  { label: '日本語', value: 'ja-JP' },
];

/** What the console calls a language it takes from the request. */
const SYSTEM_LOCALE_PREFERENCE = 'system';

/**
 * Writes the cookies the console keeps its own look and language in, and shows
 * the window again so it is drawn in what was chosen.
 *
 * Both are read when a page is rendered — the appearance on the server, the
 * language by next-intl — so a pick here is followed by a reload rather than by
 * an attempt to reach into a page that is already on the screen.
 */
const writeConsolePreferences = async (cookies: Cookie[]): Promise<void> => {
  if (!consoleOrigin) {
    return;
  }

  for (const cookie of cookies) {
    try {
      await session.defaultSession.cookies.set({
        ...cookie,
        url: `${consoleOrigin}/`,
      });
    } catch (error) {
      // Worth saying out loud: a preference that did not land looks like a menu
      // item that does nothing.
      console.warn(`Could not save ${cookie.name}: ${describeError(error)}`);

      return;
    }
  }

  refreshMenus();

  // Only a console that is being served can be asked for another page: a paused
  // gateway has no window to reload, and the choice is there next time.
  if (mainWindow && !mainWindow.isDestroyed() && gateway) {
    mainWindow.reload();
  }
};

/**
 * The appearance the console is in, with `system` answered from the computer.
 *
 * Resolved here, where the computer's own is known: the cookie is what a
 * server-rendered page starts from, and a page rendered before the desktop
 * changes cannot be asked to notice.
 */
const resolvedConsoleTheme = (): 'dark' | 'light' =>
  consoleTheme === 'system'
    ? nativeTheme.shouldUseDarkColors
      ? 'dark'
      : 'light'
    : consoleTheme;

/**
 * What a window is painted, behind the page in it and before there is one.
 *
 * On macOS, nothing: the window is drawn on the desktop's blur, which is made
 * from what is behind the window — and a background of its own would be what
 * the blur was taken of. Everywhere else the desktop paints no such material
 * and a window is the colour it is painted, so it is painted the console's: a
 * window that comes up in another colour is a flash of the one thing on the
 * screen that is not the console.
 */
const windowBackground = (): string =>
  process.platform === 'darwin'
    ? TRANSPARENT_WINDOW_BACKGROUND
    : CONSOLE_BACKGROUND[resolvedConsoleTheme()];

/**
 * Repaints the windows that are already open, in the appearance they are now
 * in.
 *
 * The colour is behind the page, so it is the reload a choice of appearance
 * causes that shows it: a window painted for a dark console while the page is
 * being re-rendered light is the flash this exists to prevent.
 */
const repaintWindowBackgrounds = (): void => {
  const colour = windowBackground();

  for (const window of [mainWindow, backendWindow]) {
    if (window && !window.isDestroyed()) {
      window.setBackgroundColor(colour);
    }
  }
};

/** Picks the appearance the console is drawn in. */
const chooseAppearance = (next: 'dark' | 'light' | 'system'): void => {
  consoleTheme = next;

  void writeConsolePreferences([
    { name: themeCookieName, value: next },
    {
      // `system` is resolved here, where the preference the whole computer is
      // in is known: the cookie is what a server-rendered page starts from, and
      // a page rendered before the OS changes cannot be asked to notice.
      name: resolvedThemeCookieName,
      value: resolvedConsoleTheme(),
    },
  ]);

  repaintWindowBackgrounds();
};

/** Picks the language the console speaks. */
const chooseLocale = (next: string): void => {
  consoleLocalePreference = next;

  void writeConsolePreferences([
    { name: localePreferenceCookieName, value: next },
    // Emptied rather than left standing when the choice is the system's: a
    // locale cookie from before would keep answering for it.
    {
      name: localeCookieName,
      value: next === SYSTEM_LOCALE_PREFERENCE ? '' : next,
    },
  ]);
};

/**
 * The appearance and the language, in the menu bar rather than in the console:
 * the window is a window of this computer, and a desktop app is dressed from the
 * place its other settings are — not from a picker inside the page.
 */
const appearanceMenu = (): MenuItemConstructorOptions => ({
  label: text().appearance,
  submenu: [
    {
      checked: consoleTheme === 'light',
      click: () => chooseAppearance('light'),
      label: text().themeLight,
      type: 'radio',
    },
    {
      checked: consoleTheme === 'dark',
      click: () => chooseAppearance('dark'),
      label: text().themeDark,
      type: 'radio',
    },
    {
      checked: consoleTheme === 'system',
      click: () => chooseAppearance('system'),
      label: text().themeSystem,
      type: 'radio',
    },
  ],
});

const languageMenu = (): MenuItemConstructorOptions => ({
  label: text().language,
  submenu: [
    {
      checked: consoleLocalePreference === SYSTEM_LOCALE_PREFERENCE,
      click: () => chooseLocale(SYSTEM_LOCALE_PREFERENCE),
      label: text().languageSystem,
      type: 'radio',
    },
    ...LOCALE_MENU_ITEMS.map(({ label, value }) => ({
      checked: consoleLocalePreference === value,
      click: () => chooseLocale(value),
      label,
      type: 'radio' as const,
    })),
  ],
});

/**
 * The menu the tray item opens: what the app is doing, the console it serves, and
 * the settings that decide both — the whole app, in the one place it is always
 * reachable from.
 */
const buildTrayMenu = (): Menu =>
  Menu.buildFromTemplate([
    { enabled: false, label: `${APP_TITLE} · ${statusLabel()}` },
    // Nothing to say about the usage yet says so in words, not with a number.
    { enabled: false, label: usageLabel() || text().usageUnavailable },
    { type: 'separator' },
    /*
      Starting and stopping the gateway is the one thing the menu bar item does
      to the gateway itself, so it is the first thing in the menu — and only
      this machine's gateway is the app's to stop. With a deployment named, the
      gateway here is the console's way to it: there is nothing to pause, and
      what runs is the deployment's to control from the console.
    */
    ...(backend.mode === 'local'
      ? [
          {
            click: () => void setPaused(status !== 'paused'),
            label: status === 'paused' ? text().resume : text().pause,
          },
        ]
      : []),
    { click: () => openConsoleOnRequest(), label: text().openConsole },
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
    // The settings: the backend and the port in a tab of their own, beside one
    // that says what this app is.
    { click: () => void openSettings(), label: text().settings },
    // Signing in is only a question with a deployment behind the console: this
    // machine's own gateway is reachable by nothing but this app's window, which
    // needs no approval from anybody.
    ...(backend.mode === 'remote' ? [deviceMenu()] : []),
    { type: 'separator' },
    // How the console looks and what language it speaks: the desktop's to
    // decide, so the window carries no pickers of its own.
    ...(consoleOrigin
      ? [appearanceMenu(), languageMenu(), { type: 'separator' as const }]
      : []),
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

/**
 * The menu at the top of the screen on macOS, and the one a window carries
 * everywhere else.
 *
 * Built and set rather than left to Electron's own, which is named for the
 * process that is running — "Electron" — and carries nothing of this app's. The
 * one here is named for the app and carries the two settings a desktop app is
 * dressed from, so the console needs no pickers of its own: the same two the
 * menu bar item has, and for the same reason — the window is a window of this
 * computer.
 *
 * The rest is the menus every windowed app on the platform has, taken whole
 * from Electron: the Edit menu, without which a console window has no copy and
 * paste at all, and on macOS the Window one, which is how a window is put away
 * and brought back.
 */
const buildApplicationMenu = (): Menu =>
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' as const },
    ...(consoleOrigin ? [appearanceMenu(), languageMenu()] : []),
    ...(process.platform === 'darwin' ? [{ role: 'windowMenu' as const }] : []),
  ]);

const refreshMenus = (): void => {
  // Set whether or not a menu bar item could be drawn: the menu at the top of
  // the screen is this app's name and its settings, and an icon that never
  // appeared is no reason to go by the process's instead.
  Menu.setApplicationMenu(buildApplicationMenu());

  if (!tray) {
    return;
  }

  // The pieces that have something to say, and no empty join between them.
  const parts = [APP_TITLE, statusLabel(), usageLabel()].filter(Boolean);

  tray.setToolTip(parts.join(' · '));
  tray.setContextMenu(buildTrayMenu());

  // macOS only: a short title beside the icon. Today's usage is the number
  // worth having in front of you; the address is a click away — and nothing at
  // all until there is a number, because an icon with "…" beside it is an icon
  // that never says anything.
  if (process.platform === 'darwin') {
    tray.setTitle(
      // Stopped is the one thing worth saying instead of a number: a count
      // beside an icon that is not running is a count that stopped moving.
      status === 'paused' ? text().paused : usageLabel(),
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

/*
  Drawn at module scope, before `ready` and before anything is awaited: macOS
  puts the tile in the Dock as soon as the process starts, which is before a
  line of this file runs, and every moment between the two is a moment the Dock
  says "Electron". Shortening that is all this can do — the tile is the
  bundle's, and a bundle is what `scripts/build-desktop.ts` builds for
  development to run.
*/
applyDevelopmentIcon();

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
      openConsoleOnRequest();
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
  refreshMenus();
};

/**
 * What makes a run a development one, and where the console it serves lives.
 *
 * Set by `scripts/dev-desktop.ts`, which is the only thing that can say: the app
 * is a bundle with no repository beside it, and nothing in it knows what ran it.
 */
const DEV_CONSOLE_ENV = 'CODEBUDDY_DESKTOP_DEV';
const DEV_CONSOLE_ROOT_ENV = 'CODEBUDDY_DESKTOP_DEV_ROOT';
const DEV_CONSOLE_RUNTIME_ENV = 'CODEBUDDY_DESKTOP_DEV_RUNTIME';
/**
 * How long a console compiled on demand is given to answer its first request.
 *
 * `next dev` builds a page when it is asked for, so the first answer is a
 * compile and not a read — several of them, one after another, on a cold cache.
 */
const DEV_CONSOLE_TIMEOUT_MS = 180_000;

/** The repository the console is served from, when it is served from one. */
const devConsole = (): { root: string; runtime: string } | null => {
  if (process.env[DEV_CONSOLE_ENV]?.trim() !== '1') {
    return null;
  }

  const root = process.env[DEV_CONSOLE_ROOT_ENV]?.trim();
  const runtime = process.env[DEV_CONSOLE_RUNTIME_ENV]?.trim();

  return root && runtime ? { root, runtime } : null;
};

/**
 * The gateway as `next dev`, in the repository, on the port the shell picked.
 *
 * Everything the built gateway is given — the console's token, the storage, the
 * deployment to forward to — reaches it through the environment either way, so
 * the only thing this changes is where the pages come from: the source, watched
 * by Next and pushed into the window over Fast Refresh, instead of a build the
 * app has to be restarted to pick up.
 *
 * Undefined outside a development run, which leaves `startGateway` spawning the
 * bundled server as it always has.
 */
const devConsoleSpawn = (port: number): GatewaySpawn | undefined => {
  const dev = devConsole();

  if (!dev) {
    return undefined;
  }

  return ({ env }) => {
    const childEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: 'development' };

    // The built gateway runs on this app's own binary, switched into Node by
    // this; the one in the repository is an ordinary runtime, to which the
    // switch means nothing.
    delete childEnv.ELECTRON_RUN_AS_NODE;

    return spawn(
      dev.runtime,
      ['run', 'dev', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: dev.root,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  };
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
    /*
      Where the console itself comes from: the source, when the app was started
      by `scripts/dev-desktop.ts`, and the build it ships otherwise.

      A development run gets `next dev` in the repository instead, which is the
      only thing that answers a changed page with the page: Fast Refresh takes
      the window's own connection, so a save to the console is a save the window
      shows, with no build behind it and no relaunch.
    */
    spawn: devConsoleSpawn(port),
    // Compiled on demand, so a cold development console takes longer than a
    // built one to answer its first request — and a first request is what the
    // health check is.
    timeoutMs: devConsole() ? DEV_CONSOLE_TIMEOUT_MS : undefined,
    // The gateway can also die later — a crash, or a database that stops
    // answering. Nothing restarts it then, but the menu bar must stop claiming
    // it is running.
    onUnexpectedExit: (error) => {
      gateway = null;
      status = 'failed';
      refreshMenus();
      dialog.showErrorBox(
        APP_TITLE,
        `The local gateway stopped unexpectedly.\n\n${describeError(error)}`,
      );
    },
    // Held only until this start has landed: a quit in the meantime has no
    // handle to stop the gateway with, and the child is what holds the port.
    onChild: (child) => {
      pendingChild = child;
    },
    port,
  });
};

/**
 * Hands the gateway back now, rather than when this process is done with it.
 *
 * `app.exit()` is the one way out that does not run `before-quit`, which is
 * where the gateway is normally stopped — so anything that leaves through it
 * leaves the gateway behind: a child that keeps the port, and a build that
 * starts beside it only to find its own port taken by the build it replaced.
 */
/**
 * Stops the gateway, and waits until it has let go of what it was holding.
 *
 * `stop()` is a signal and not an exit: the gateway finishes what it is doing
 * and goes, and while it is going it is still serving. Asked whether the port
 * is free before it has gone, it answers no — and the app reports the port the
 * user asked for as taken by somebody else, and asks them to name another.
 *
 * So the port is only ever asked about once the gateway that had it is gone,
 * which is also why the wait is bounded: a gateway that will not go is not
 * something this app can wait for.
 */
const stopGatewayAndWait = async (): Promise<void> => {
  const stopping = gateway;

  gateway = null;

  if (!stopping) {
    return;
  }

  stopping.stop();

  await Promise.race([stopping.exited, delay(GATEWAY_EXIT_GRACE_MS)]);
};

/**
 * When a child that has been killed is actually gone.
 *
 * A child is stopped through the process when there is no handle to stop it
 * with, and `kill()` is a signal like any other: it is gone later, and it is
 * holding its port until then.
 */
const childGone = (child: GatewayProcess | null): Promise<void> =>
  new Promise((resolve) => {
    if (!child) {
      resolve();

      return;
    }

    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

const stopGatewayNow = async (): Promise<void> => {
  await stopGatewayAndWait();

  // A start that has not landed has no handle to stop, and it is the child —
  // not the handle — that is holding the port.
  pendingChild?.kill();
  pendingChild = null;
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
    // Nothing after this starts a gateway, so nothing can answer a click that
    // was waiting for one.
    consoleRequestPending = false;

    return;
  }

  // Paused is a stop the user asked for, so nothing that would start the
  // gateway — a setting saved in the console, a device signed in — starts it.
  if (paused) {
    await stopGatewayAndWait();
    status = 'paused';
    refreshMenus();
    // Forgotten rather than left waiting: the console is not coming up, and a
    // click remembered here is a window that opens by itself minutes later,
    // when the gateway is resumed for something else entirely.
    consoleRequestPending = false;

    return;
  }

  if (restarting) {
    scheduleRestart();

    return;
  }

  restarting = true;
  status = 'starting';
  refreshMenus();

  const startedFor = backend;
  const upstream = backend.mode === 'remote' ? backend.url : null;

  if (upstream) {
    lastProbe = await probeDeployment({ url: upstream });

    if (lastProbe.kind !== 'ready') {
      restarting = false;
      await stopGatewayAndWait();
      status = 'unreachable';
      refreshMenus();
      // Dropped here rather than in the `finally` below, which this return is
      // above: a click waiting for a console is waiting for one that is not
      // coming, and left set it is a window that opens on its own the next
      // time anything starts successfully.
      consoleRequestPending = false;
      // The console has nothing to show yet, so what the user is asked is how to
      // get to a deployment that answers. Raised rather than asked: a start can
      // be under way because an answer is being applied, and this question came
      // out of that answer.
      raiseBackendQuestion('unreachable');

      return;
    }
  } else {
    lastProbe = null;
  }

  try {
    // The gateway that is running still holds its port, so probing before
    // stopping it would reject the port the app is already on — the one just
    // saved included — and settle on the next one instead. Released first, and
    // waited for: a gateway that has been asked to stop is still answering a
    // moment later, and the probe cannot tell it from a stranger.
    await stopGatewayAndWait();

    const port = await resolveStartPort();

    // The one number the app cannot pick for the user. Asked about rather than
    // reported in an error box: it is a setting to change, not a failure of the
    // app, and the gateway keeps nothing to serve until it is.
    if (port === null) {
      portBusy = preferredPort();
      status = 'portBusy';
      refreshMenus();
      raiseBackendQuestion('portInUse');

      return;
    }

    pendingStart = launchGateway(port, upstream);
    gateway = await pendingStart;
    pendingStart = null;
    pendingChild = null;

    // The port probe and the health check take seconds, and the backend can
    // change meanwhile — give this gateway back instead of steering the console
    // to a build started for a backend the app has already walked away from.
    if (quitting || !sameBackend(backend, startedFor)) {
      await stopGatewayAndWait();

      return;
    }

    // The gateway takes seconds to come up, and Pause can be pressed while it
    // does. A pause is a stop the user asked for: the handle this start is
    // holding is handed back, rather than left running behind a tray that says
    // it is paused — and rather than being killed by the next restart, which
    // is what happens to a gateway nobody knows is up.
    if (paused) {
      await stopGatewayAndWait();
      status = 'paused';
      refreshMenus();

      return;
    }

    consoleOrigin = new URL(gateway.url).origin;
    portBusy = null;
    status = 'running';
    refreshMenus();
  } catch (error) {
    gateway = null;
    status = 'failed';
    refreshMenus();
    dialog.showErrorBox(
      APP_TITLE,
      `The local gateway failed to start.\n\n${describeError(error)}`,
    );
  } finally {
    restarting = false;

    // Somebody asked for the console while there was none to open. Answered now
    // that there is one, and dropped when there is not — a start that failed
    // has already been put in front of them, and a window opening on top of
    // that is not what they asked for.
    //
    // Dropped on every way out, not only on the ones that got as far as the
    // end: a start that gave up — a deployment that did not answer, a port
    // something else is serving, a backend that changed underneath it — is
    // answered by the question it put on the screen, and a click left waiting
    // behind it is a console that opens on its own the next time anything
    // starts successfully.
    if (consoleRequestPending) {
      consoleRequestPending = false;

      if (status === 'running') {
        showMainWindow();
      }
    }
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

  // What the console is drawn in, and the choice behind its language: the menu
  // bar item offers both, and an offer that does not know what is already
  // picked is an offer that marks nothing.
  consoleTheme = parseThemeMode(
    cookies.find((it) => it.name === themeCookieName)?.value,
  );

  const preference = cookies.find(
    (it) => it.name === localePreferenceCookieName,
  )?.value;

  if (preference) {
    consoleLocalePreference = preference;
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

  refreshMenus();
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
    // Given back before this process is: `app.exit` does not run `before-quit`,
    // which is the only place the gateway is stopped, so a child that outlives
    // the app that spawned it keeps the port — and the build that starts next
    // finds its own port taken by the build it replaced, and asks the user to
    // name another one the moment it has been updated.
    await stopGatewayNow();
    // Relaunched before it quits: the file it starts is the one just written.
    app.relaunch();
    app.exit(0);
  } catch (error) {
    await fs.promises.rm(staged, { force: true });
    dialog.showErrorBox(
      APP_TITLE,
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
  refreshMenus();

  try {
    const current = app.getVersion();
    const update = await checkForUpdate({ currentVersion: current });

    if (update.kind === 'unavailable') {
      await dialog.showMessageBox({
        message: updateUnavailableMessage(update.reason),
        title: APP_TITLE,
      });

      return;
    }

    if (update.kind === 'up-to-date') {
      await dialog.showMessageBox({
        message: fillText(text().updateUpToDate, {
          version: update.version,
        }),
        title: APP_TITLE,
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
        title: APP_TITLE,
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
    refreshMenus();

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
      APP_TITLE,
      `${text().updateFailed}\n\n${describeError(error)}`,
    );
  } finally {
    updateState = 'idle';
    refreshMenus();
  }
};

/**
 * Whether the deployment behind the console wants this app signed in to it.
 *
 * Asked of the deployment, which is the one that owns the password: a desktop
 * install has none of its own, and a console showing a deployment's data is
 * signed in — or not — there. This machine's own gateway is reachable by
 * nothing but this app's own window, which needs no approval from anybody.
 *
 * A deployment that could not be asked is one that is not made to answer twice:
 * the console comes up and says what it can, which is what it does already.
 */
const deploymentNeedsSignIn = async (): Promise<boolean> => {
  if (backend.mode !== 'remote') {
    return false;
  }

  const session = await fetchUpstreamSessionSummary({
    deviceToken,
    upstream: backend.url,
  });

  return session === null
    ? false
    : session.accountConfigured && !session.authenticated;
};

/**
 * Loads the console again, into a window that is already open.
 *
 * A window is only brought forward once a backend has been applied, and the page
 * it holds is the one the backend before it served — a deployment's login page
 * above all, which is a page this machine's own gateway has no use for and
 * nothing to say on.
 */
const reloadConsole = (): void => {
  const baseUrl = consoleBaseUrl();

  if (!baseUrl || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  void loadConsole(mainWindow, `${baseUrl}/dashboard`);
};

/**
 * Signs this app in with the device where the console is about to be opened on a
 * deployment that wants one, and does nothing anywhere else.
 *
 * A deployment this app is not signed in to answers the console with its own
 * login page — and a passkey saved for the deployment is of no use on one: a
 * browser offers a credential to the origin it is on, which is 127.0.0.1 here.
 * So the sign-in is made the way it is everywhere else in this app: the
 * device's, in a browser, on the page the deployment serves for it.
 *
 * Quietly, because the console is about to be opened either way, and a
 * deployment that does not answer the device flow still has its login page to
 * offer — a password, which a window at 127.0.0.1 can carry to it. Reporting
 * that as a failure would put a dialog in front of the page about to ask.
 */
const signInIfTheDeploymentAsks = async (): Promise<void> => {
  if (await deploymentNeedsSignIn()) {
    await signInToDeployment(true);
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
  {
    /**
     * Set when the choice came from the button that says 去认证: the press is a
     * request to be signed in, so the deployment is asked whatever it answers to
     * a sign-in, rather than only when it has already said it wants one.
     */
    authenticate = false,
    persist = false,
    port,
  }: { authenticate?: boolean; persist?: boolean; port?: number } = {},
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
        APP_TITLE,
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
  refreshMenus();

  await restartGateway();

  if (status === 'running') {
    /*
      Signed in before the console is opened on it: a deployment that wants one
      answers the console with its own login page, and a login page in this app's
      window is not one anybody can sign in on.

      Pressed to be signed in, it is asked outright rather than waited on to ask:
      the button under its address is the request, and what it is answered with
      is the deployment's own page in a browser — not a page of its own in this
      window.
    */
    if (authenticate) {
      await signInToDeployment(true);
    } else {
      await signInIfTheDeploymentAsks();
    }

    // A window already open holds the page the last backend served — a
    // deployment's login page, most of all — and a window that is merely brought
    // forward keeps showing it. Loaded again at the console this one serves.
    reloadConsole();
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
        loadBundledPage(backendWindow, path.join(bundleDir(), 'backend.html'));
      }

      backendWindow.focus();

      return;
    }
  }

  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    height: BACKEND_WINDOW_HEIGHT,
    icon: windowIcon(),
    resizable: false,
    // One place to find the app: the menu bar item.
    skipTaskbar: SKIP_TASKBAR,
    // Shown once the page in it has drawn, which is also once the page has
    // said how big it wants to be: a window put on the screen before that is
    // a white flash first and a jump to its real size after.
    show: false,
    title: APP_TITLE,
    // The page measures itself and asks for the size it needs, so these numbers
    // are the page's own and not the window around it.
    useContentSize: true,
    ...(process.platform === 'darwin'
      ? { vibrancy: WINDOW_VIBRANCY }
      : undefined),
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
    backendWindowWasLast = true;

    // A first launch that never got its answer has nothing to fall back on, so
    // it quits: the gateway is the thing the answer decides, and starting one
    // the user did not ask for is not an answer they gave. Once a backend has
    // been chosen, closing this window leaves the app running as it was.
    if (!backendChosen) {
      app.quit();
    }
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  keepWindowTitle(window);

  backendWindow = window;
  backendScreen = screen;

  loadBundledPage(window, path.join(bundleDir(), 'backend.html'));
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
    title: APP_TITLE,
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
      title: APP_TITLE,
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
    await stopGatewayAndWait();

    // A start already running is the one that says it is paused: it reads
    // `paused` again after every await, and stops the gateway it was bringing
    // up when it lands. Written here as well, `paused` is a status the click
    // that follows answers with the question it has just answered — a Resume
    // that opens the same dialog again, and starts a second gateway behind
    // the one that is already coming up.
    if (!restarting) {
      status = 'paused';
      refreshMenus();
    }

    return;
  }

  // A start already running answers the resume by itself: it reads `paused`
  // again after every await, before it calls the gateway up. Scheduling a
  // second one here is a gateway stopped and started again a moment later —
  // and a console window sent to a new address for no reason the user can
  // see — which is what a Pause pressed and taken back during a start got.
  if (restarting) {
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
  // The desktop is already asking which backend to use, in a dialog of its own.
  // A second window asking the same question is one the app cannot be answered
  // twice on — and closing it quits, because a first launch with no backend has
  // nothing to keep running.
  if (backendQuestions.asking) {
    return;
  }

  openBackendWindow({ screen: 'settings' });
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
const signInToDeployment = async (quiet = false): Promise<void> => {
  // This machine's own gateway is served to nobody but this app's window: there
  // is no deployment to be approved by, and so no sign-in to make.
  if (backend.mode !== 'remote' || signingIn) {
    return;
  }

  const shell = text();
  /*
    Said in a dialog of the computer's own, unless the sign-in was this app's
    own idea rather than a click on the menu bar item.

    Quiet, because a deployment that does not answer the device flow is not a
    failure to report when nobody asked for it: what it answers the console with
    is the login page it would have shown anyway, which is the only way in it
    offers — a password, typed in this window — and a dialog in front of a page
    about to explain itself is a dialog that hides the explanation.
  */
  const say = (message: string): void => {
    if (!quiet) {
      dialog.showErrorBox(APP_TITLE, message);
    }
  };
  // Named before anything is asked of it: the grant is that deployment's, and
  // the token that comes back is a promise it made. The backend can be pointed
  // somewhere else while the user is still approving, and a token saved under
  // the new address would be carried to a deployment that never issued it.
  const issuedBy = backend.url;
  // Named before anything is asked of it, and before the first await: the menu
  // bar item is rebuilt while this waits, and an item that still says "Sign in"
  // is a second sign-in — two codes on two screens, the one the user did not
  // approve left to run out, and a second gateway restart behind it.
  signingIn = true;
  refreshMenus();

  /*
    Listening before the code is asked for: the address the deployment sends the
    browser back to has to be named in the request, and a port this machine has
    going is only known once it is bound.
  */
  const listener = await startDeviceRedirectListener({
    state: randomBytes(16).toString('hex'),
  });

  const requested = await requestDeviceAuthorization({
    baseUrl: issuedBy,
    redirectUri: listener.redirectUri,
  });

  if (requested.kind !== 'granted') {
    listener.close();
    say(
      requested.kind === 'notConfigured'
        ? shell.deviceNotConfigured
        : shell.deviceSignInFailed,
    );

    return;
  }

  const { grant } = requested;
  /*
    Where the user approves: the deployment's own page, in the browser, with the
    code already in its address — so there is nothing to show them first, and no
    code to carry across by hand.

    And where they come back from: this machine, on the address above, with the
    token in it. Which is why nothing here asks again — a native app has no
    secret to keep and no reason to be polling for an answer the browser is
    already on its way back with.
  */
  openExternally(grant.verificationUriComplete || grant.verificationUri);

  try {
    const token = await listener.wait(grant.expiresIn * 1000);

    if (!token) {
      say(shell.deviceSignInExpired);

      return;
    }

    // Approved by a deployment that is no longer the one behind the console:
    // the code was shown for the old address, and this token opens its door.
    // Keeping it would present one deployment's introduction to another.
    if (backend.mode !== 'remote' || backend.url !== issuedBy) {
      say(shell.deviceSignInFailed);

      return;
    }

    try {
      writeDeviceToken(userDataDir, {
        token: token.accessToken,
        url: issuedBy,
      });
    } catch (error) {
      // Approved by the user, in their browser, and then dropped on the floor
      // because this machine would not take the file: said in a dialog of the
      // computer's own, the way every other failure to save a setting is.
      say(`${shell.deviceSignInFailed}\n\n${describeError(error)}`);

      return;
    }

    deviceToken = token.accessToken;
    refreshMenus();

    // Restarted because the token reaches the gateway in its environment: the
    // console the window already holds is a page that was signed out, and the one
    // it gets after this is signed in.
    await restartGateway();
  } finally {
    signingIn = false;
    refreshMenus();
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
  refreshMenus();

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

    // Answered this time, and the console comes up: a deployment that was
    // merely cold is running now, and an app that says so only in the menu bar
    // item is an app the user has to know to click. The window's own retry says
    // the same thing, and so does changing the backend.
    if (status === 'running') {
      showMainWindow();
    }

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
  // A second question on the screen at once is one the user cannot answer
  // twice: the answer to this one is what the app is waiting for.
  if (!backendQuestions.begin()) {
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

  // A question is on the screen from here until the finally below, which is also
  // what keeps the window from being opened while one is being answered.
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
      dialog.showErrorBox(APP_TITLE, couldNotAskMessage(screen));
    }

    return kind;
  } finally {
    // Says the question is over, which is the moment the one its answer raised
    // can be put in front of the user.
    backendQuestions.end();
  }
};

/**
 * Puts the question an answer raised in front of the user.
 *
 * Kept until the question it came out of is over, and asked then: raised from
 * inside that ask it would be asking twice at once, and dropped instead it
 * would be an answer the user never hears about.
 */
const raiseBackendQuestion = (screen: BackendScreen): void => {
  backendQuestions.raise(screen);
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
    // Signed in before the console is opened on it: a deployment that wants one
    // answers the console with its own login page, and a login page in this
    // app's window is not one anybody can sign in on.
    await signInIfTheDeploymentAsks();
    reloadConsole();
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
  /**
   * Whether the deployment behind the console has signed this app in.
   *
   * What the button under a deployment's address is disabled by: an address
   * that is already the one saved, to a deployment that has already answered,
   * has nothing left for the button to do.
   */
  signedIn: Boolean(deviceToken),
  text: text(),
  unreachable: unreachableInfo(),
}));

/**
 * Saves what the window settled: which backend, and which port to serve on.
 *
 * Answered only once the choice has been applied — which for a deployment means
 * once it has been asked to sign this app in and the browser has answered, or
 * been given up on. The window stays open until then: the button that started
 * it is the one that says how it went, and a window that closed the moment it
 * was pressed leaves the answer nowhere to land.
 */
ipcMain.handle('desktop:set-backend', async (_event, next: unknown) => {
  const window = backendWindow;
  const record =
    next && typeof next === 'object' && !Array.isArray(next)
      ? (next as { backend?: unknown; port?: unknown })
      : {};

  // Normalized here, at the boundary a page can reach: the window has no say in
  // what counts as a backend or as a port.
  const port = normalizeDesktopPort(record.port, 0);
  const chosen = normalizeDesktopBackend(record.backend);

  /*
    This machine's own gateway is restarted behind the choice, and nothing about
    it is answered in another app: the window closes on the press, the way a
    dialog does, and the gateway is up by the time the console is asked for.

    Waited for only when the choice is a deployment's. Its sign-in is a
    browser's to answer, on the deployment's own page, and this window is where
    what came of it is reported — so it stays open, and the press is answered
    when the answer lands or the browser is closed on.
  */
  if (chosen.mode !== 'remote') {
    void applyBackend(chosen, {
      persist: true,
      // A port the page did not settle — one it never showed, or one left blank
      // — leaves the one on disk standing.
      port: port || undefined,
    });
    closeWindow(window);

    return { signedIn: false };
  }

  // Pressed to be authenticated, when it was the button under a deployment's
  // address that did the pressing: the sign-in is the request, not something the
  // deployment is waited on to ask for.
  await applyBackend(chosen, {
    authenticate: true,
    persist: true,
    port: port || undefined,
  });

  return { signedIn: Boolean(deviceToken) };
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

  // Answered this time: the question goes away and the console comes up. The
  // window is on its way out, and `showMainWindow` asks whether there is one
  // still asking — a window `close()` has been called on still says it is
  // there, so it would be handed the click and the console would never open.
  if (status === 'running') {
    backendWindow = null;

    // The restart was seconds long, and the user may have closed the window
    // while it was being asked: `close()` throws on a window that is gone, and
    // the console below would never open.
    closeWindow(window);
    showMainWindow();

    return;
  }

  // Not answered: the window is still the only thing that can say so, and it is
  // showing what it was told before — the same screen, the same message, as if
  // nothing had been asked. Loaded again for the answer it now has.
  if (window && !window.isDestroyed()) {
    loadBundledPage(window, path.join(bundleDir(), 'backend.html'));
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
    openConsoleOnRequest();
  });

  // On macOS the gateway keeps serving API clients after the console window is
  // closed; elsewhere closing the window is quitting the app. A launch that is
  // still asking which backend to use, or still starting a gateway, has a
  // window of its own to lose first.
  app.on('window-all-closed', () => {
    const askedLast = backendWindowWasLast;

    backendWindowWasLast = false;

    if (process.platform === 'darwin' || askedLast || restarting) {
      return;
    }

    app.quit();
  });

  app.on('activate', () => {
    openConsoleOnRequest();
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

      // Stopped and waited for, the way it is everywhere else: `stop()` is a
      // signal and not an exit, and `app.exit()` does not wait for the child
      // to go. A gateway that has been asked to stop is still holding its
      // port, and the launch after this one is the one that finds it taken.
      await stopGatewayAndWait();

      // A gateway that is still starting has already spawned a child, but the
      // handle that could stop it does not exist until it is healthy. Wait for
      // it, briefly, so quitting mid-restart cannot leave a gateway behind
      // holding the port the next launch wants.
      if (pendingStart) {
        const started = await Promise.race([
          pendingStart.catch(() => null),
          delay(QUIT_GRACE_MS),
        ]);

        // Stopped through the handle when the start landed, and through the
        // process when it did not: a gateway still coming up has no handle
        // yet, and it is the child — not the app — that would keep the port.
        const child = started ? null : pendingChild;

        if (started) {
          started.stop();
        } else {
          child?.kill();
        }

        // Waited for through whichever of the two was stopped, and not
        // through `gateway`: a start that lands while the app is quitting is
        // already being stopped by the restart it came out of, which has
        // taken the handle back out of that slot — waiting on the slot there
        // waits for nothing at all.
        await Promise.race([
          started ? started.exited : childGone(child),
          delay(GATEWAY_EXIT_GRACE_MS),
        ]);
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
      refreshMenus();
      dialog.showErrorBox(
        APP_TITLE,
        `The local gateway failed to start.\n\n${describeError(error)}`,
      );
      app.quit();
    }
  });
}
