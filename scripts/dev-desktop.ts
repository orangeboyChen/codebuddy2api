/**
 * Runs the app in development, and keeps it running as it changes.
 *
 * `electron .` is not this app: it is Electron's own bundle, running this app's
 * files, and everything macOS reads off a bundle — the name at the top of the
 * screen, the Dock tile, the About panel and the picture in it — is Electron's.
 * `app.setName` and `app.dock.setIcon` paper over two of those and cannot reach
 * the rest, so development runs the app the way an install does: as a bundle of
 * its own, built by electron-builder with the development icon and with no
 * archive inside it, so the shell in it can be replaced in place.
 *
 * The console is hot: the app is started on `next dev` in the repository, so a
 * save to a page is a page the window is already showing, pushed into it over
 * Fast Refresh — no build behind it, and no relaunch.
 *
 * The shell is not, because it cannot be: Electron has no way to load a second
 * main process. A save under `electron/` is re-bundled, copied into the app and
 * answered by a relaunch, which takes a second or two.
 *
 * Usage: `bun run desktop:dev [--app]`
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleElectron, bunBinary, prepareDesktop } from './build-desktop';

/** Where the repository is, whichever directory this is run from. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appBundleDir = path.join(root, 'build', 'electron-app');
/*
  Its own output directory, which is what keeps the two apart: electron-builder
  writes a release to `build/desktop`, and an app left there by one is not an
  app this command can tell from its own — so a release built after a
  development run, or before it, was the one development then launched, in the
  release's icon.
*/
const devOutput = path.join(root, 'build', 'desktop-dev');
const builderConfig = path.join(root, 'electron', 'electron-builder.yml');
const standaloneServer = path.join(root, '.next', 'standalone', 'server.js');
const APP_NAME = 'CodeBuddy2API';
/** How long a save is given to finish before the shell is bundled again. */
const SETTLE_MS = 120;

/** What electron-builder unpacked, on the platform that has a bundle to unpack. */
const devApp = (): string | null => {
  if (process.platform !== 'darwin' || !fs.existsSync(devOutput)) {
    return null;
  }

  for (const entry of fs.readdirSync(devOutput)) {
    if (!entry.startsWith('mac')) {
      continue;
    }

    const candidate = path.join(devOutput, entry, `${APP_NAME}.app`);

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

/**
 * What is run, and where the shell inside it lives.
 *
 * A Mac runs the app it was given; everywhere else there is no bundle for the
 * desktop to read a name or an icon off, so `electron .` is still the app — and
 * the shell it reads is the one in `build/`, which is where bundling puts it.
 */
const devTarget = (): {
  args: string[];
  command: string;
  shellDir: string | null;
} => {
  const app = devApp();

  if (app && process.platform === 'darwin') {
    return {
      args: [],
      command: path.join(app, 'Contents', 'MacOS', APP_NAME),
      shellDir: path.join(app, 'Contents', 'Resources', 'app'),
    };
  }

  const binary =
    process.platform === 'darwin'
      ? path.join(
          root,
          'node_modules',
          'electron',
          'dist',
          'Electron.app',
          'Contents',
          'MacOS',
          'Electron',
        )
      : path.join(
          root,
          'node_modules',
          'electron',
          'dist',
          process.platform === 'win32' ? 'electron.exe' : 'electron',
        );

  if (!fs.existsSync(binary)) {
    throw new Error(
      `${path.relative(root, binary)} is missing. Run \`bun install\` first.`,
    );
  }

  return { args: ['.'], command: binary, shellDir: null };
};

/**
 * What the app is packaged out of, besides the shell.
 *
 * The shell is put inside the app on every launch, so it is not what makes an
 * app stale — but the icon, the manifest, the packaging configuration and the
 * gateway it carries are all baked in once, and an app left from a launch last
 * week was the one that opened, in last week's icon and with last week's
 * gateway inside it.
 */
const PACKAGE_SOURCES = [
  'package.json',
  'electron/electron-builder.yml',
  'electron/resources/icon-dev.png',
  'build/bundle/gateway',
];

/** The newest file under a path, or 0 when there is nothing there. */
const newestFileTime = (target: string, newest: number): number => {
  if (!fs.existsSync(target)) {
    return newest;
  }

  if (fs.statSync(target).isFile()) {
    return Math.max(newest, fs.statSync(target).mtimeMs);
  }

  for (const entry of fs.readdirSync(target)) {
    if (entry.startsWith('.') || entry === 'node_modules') {
      continue;
    }

    newest = newestFileTime(path.join(target, entry), newest);
  }

  return newest;
};

/**
 * Whether the app in the development output was packaged before something it is
 * packaged out of changed.
 */
const appIsStale = (): boolean => {
  const app = devApp();

  if (!app) {
    return true;
  }

  const binary = path.join(app, 'Contents', 'MacOS', APP_NAME);
  const packaged = fs.existsSync(binary) ? fs.statSync(binary).mtimeMs : 0;
  const newest = PACKAGE_SOURCES.reduce(
    (soFar, source) => newestFileTime(path.join(root, source), soFar),
    0,
  );

  return newest > packaged;
};

const runBin = (binary: string, args: string[]): void => {
  const { status } = spawnSync(bunBinary(), ['run', binary, '--', ...args], {
    cwd: root,
    stdio: 'inherit',
  });

  if (status !== 0) {
    throw new Error(`${binary} failed.`);
  }
};

/**
 * The app development runs, built when it is not there yet.
 *
 * `--dir` — no installer — and `asar: false`, because a shell inside an archive
 * cannot be replaced in place, and a watcher that cannot replace it is a
 * watcher that has to build the whole app again.
 */
const buildDevApp = (): void => {
  ensureGatewayBuild();
  prepareDesktop(true);

  runBin('electron-builder', [
    '--config',
    builderConfig,
    '--dir',
    `-c.directories.output=${devOutput}`,
    '-c.asar=false',
    `-c.mac.icon=${path.join(appBundleDir, 'icon-dev.png')}`,
    '--publish',
    'never',
  ]);
};

/**
 * The one build a development run cannot do without, and only when there is
 * none.
 *
 * The app has to *carry* a gateway to be packaged, and packaging copies one out
 * of `.next/standalone` — so a build has to have happened once. It is never the
 * one that runs: the app is started with `next dev` in the repository, which
 * serves the console from the source and pushes a changed page into the window.
 * A build older than the source is therefore fine, and only a missing one is
 * worth a minute of this command's time.
 */
const ensureGatewayBuild = (): void => {
  if (fs.existsSync(standaloneServer)) {
    return;
  }

  console.log('[dev] no build to package — running bun run build');

  const { status } = spawnSync(bunBinary(), ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });

  if (status !== 0) {
    throw new Error('bun run build failed.');
  }
};

/** The shell, re-bundled and put where the app about to be relaunched reads it. */
const rebundleShell = (): void => {
  bundleElectron();

  const { shellDir } = devTarget();

  if (!shellDir) {
    return;
  }

  fs.rmSync(shellDir, { force: true, recursive: true });
  fs.cpSync(appBundleDir, shellDir, { recursive: true });
};

/** The app, stopped through its whole process group: the gateway is in it too. */
const stop = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  try {
    // The negative pid is the group: the app started it, and the gateway the
    // app started is in it. Killed with the app, which is what leaves the port
    // free for the relaunch behind it.
    process.kill(-(child.pid ?? 0), 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  await exited;
};

const spawnDev = (): ReturnType<typeof spawn> => {
  const { args, command } = devTarget();

  return spawn(command, args, {
    cwd: root,
    // Its own group, so one signal takes the app and the gateway it started.
    detached: true,
    /*
      Where the console comes from, and what runs it. The app is a bundle with no
      repository beside it, so this is the only way it is told: `next dev` in the
      repository serves the console from the source, which is what makes a save
      to a page a page the window already shows.
    */
    env: {
      ...process.env,
      CODEBUDDY_DESKTOP_DEV: '1',
      CODEBUDDY_DESKTOP_DEV_ROOT: root,
      CODEBUDDY_DESKTOP_DEV_RUNTIME: bunBinary(),
    },
    stdio: 'inherit',
  });
};

const main = async (): Promise<void> => {
  const forceApp = process.argv.includes('--app');

  if (forceApp || appIsStale()) {
    buildDevApp();
  }

  /*
    The app already there carries whatever `electron/` held when it was built,
    which is not what it holds now — and an app left over from yesterday's run
    was the one that opened, running yesterday's shell on yesterday's console.

    Bundled again before every launch, so the app is always this repository's:
    a second or two, against a console that would otherwise be a build behind.
  */
  rebundleShell();

  let child = spawnDev();

  let timer: NodeJS.Timeout | null = null;

  fs.watch(path.join(root, 'electron'), { recursive: true }, () => {
    // One save is several events, and a bundler run per event is a bundler run
    // per keystroke.
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;

      void (async () => {
        console.log('[dev] electron/ changed — bundling and relaunching');

        await stop(child);
        rebundleShell();
        child = spawnDev();
      })();
    }, SETTLE_MS);
  });

  console.log(
    '[dev] watching electron/ — the console is next dev, and refreshes itself',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop(child).then(() => process.exit(0));
    });
  }
};

await main();
