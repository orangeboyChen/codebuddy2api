/**
 * Runs the app in development, and keeps it running as the shell changes.
 *
 * `electron .` is not this app: it is Electron's own bundle, running this app's
 * files, and everything macOS reads off a bundle — the name at the top of the
 * screen, the Dock tile, the About panel and the picture in it — is Electron's.
 * `app.setName` and `app.dock.setIcon` paper over two of those and cannot reach
 * the rest, so development runs the app the way an install does: as a bundle of
 * its own, built by electron-builder with the development icon and with no
 * archive inside it, so the shell in it can be replaced in place.
 *
 * Which is what the watcher does. Every save under `electron/` is re-bundled,
 * copied into the app, and answered by a relaunch: Electron has no way to load a
 * second main process, so a changed shell is a restarted app — a second or two,
 * rather than a build.
 *
 * The gateway is left as `bun run desktop:prepare` built it: the console's pages
 * are the production build the app ships, and changing one still wants a build.
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
const desktopOutput = path.join(root, 'build', 'desktop');
const builderConfig = path.join(root, 'electron', 'electron-builder.yml');
const APP_NAME = 'CodeBuddy2API';
/** How long a save is given to finish before the shell is bundled again. */
const SETTLE_MS = 120;

/** What electron-builder unpacked, on the platform that has a bundle to unpack. */
const devApp = (): string | null => {
  if (process.platform !== 'darwin' || !fs.existsSync(desktopOutput)) {
    return null;
  }

  for (const entry of fs.readdirSync(desktopOutput)) {
    if (!entry.startsWith('mac')) {
      continue;
    }

    const candidate = path.join(desktopOutput, entry, `${APP_NAME}.app`);

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
  prepareDesktop(true);

  runBin('electron-builder', [
    '--config',
    builderConfig,
    '--dir',
    '-c.asar=false',
    `-c.mac.icon=${path.join(appBundleDir, 'icon-dev.png')}`,
    '--publish',
    'never',
  ]);
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
    env: process.env,
    stdio: 'inherit',
  });
};

const main = async (): Promise<void> => {
  const forceApp = process.argv.includes('--app');

  if (forceApp || !devApp()) {
    buildDevApp();
  }

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

  console.log('[dev] watching electron/ — Ctrl-C to stop');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop(child).then(() => process.exit(0));
    });
  }
};

await main();
