import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DEV_ICON_FILENAME } from './dev-icon';

const root = process.cwd();
const standaloneDir = path.join(root, '.next', 'standalone');
// The gateway is nested one level deep on purpose: electron-builder always
// skips the `node_modules` directory sitting at the root of an `extraResources`
// source, so it has to be copied as `bundle/gateway` instead of `gateway`.
const gatewayDir = path.join(root, 'build', 'bundle', 'gateway');
// electron-builder packages the production dependencies of the app directory's
// package.json, which here would mean the entire Next.js dependency tree. The
// desktop app ships its own dependency-free manifest instead.
const appDir = path.join(root, 'build', 'electron-app');
const migrationsDir = path.join(root, 'lib', 'server', 'storage', 'migrations');
const resourcesDir = path.join(root, 'electron', 'resources');
const builderConfig = path.join(root, 'electron', 'electron-builder.yml');

const parseArguments = (argv: string[]) => {
  const forwarded: string[] = [];
  let devIcon = false;
  let prepareOnly = false;

  for (const argument of argv) {
    if (argument === '--dev-icon') {
      devIcon = true;
      continue;
    }

    if (argument === '--prepare-only') {
      prepareOnly = true;
      continue;
    }

    forwarded.push(argument);
  }

  return { devIcon, forwarded, prepareOnly };
};

const bunBinary = () => {
  const basename = path.basename(process.execPath).toLowerCase();

  return basename === 'bun' || basename === 'bun.exe'
    ? process.execPath
    : 'bun';
};

/**
 * Runs a CLI out of `node_modules/.bin` through bun instead of executing its
 * shim directly. On Windows that shim is a `.cmd`, which `execFile` cannot run
 * without a shell, and bun resolves the shim itself on every platform.
 */
const runBin = (binary: string, args: string[]): void => {
  execFileSync(bunBinary(), ['run', binary, '--', ...args], {
    cwd: root,
    stdio: 'inherit',
  });
};

const requirePath = (target: string, hint: string) => {
  if (!fs.existsSync(target)) {
    throw new Error(`${path.relative(root, target)} is missing. ${hint}`);
  }
};

const copyInto = (source: string, destination: string) => {
  fs.cpSync(source, destination, { recursive: true });
};

/**
 * The gateway shipped inside the desktop app is the same Next.js standalone
 * output the Docker image runs. Only the pieces that server actually needs are
 * copied: a local `next build` leaves the rest of the repository in the
 * standalone directory, which would otherwise be packaged as well.
 */
const assembleGateway = () => {
  requirePath(
    path.join(standaloneDir, 'server.js'),
    'Run `bun run build` before building the desktop app.',
  );

  fs.rmSync(gatewayDir, { force: true, recursive: true });
  fs.mkdirSync(gatewayDir, { recursive: true });

  copyInto(
    path.join(standaloneDir, 'server.js'),
    path.join(gatewayDir, 'server.js'),
  );
  copyInto(
    path.join(standaloneDir, 'package.json'),
    path.join(gatewayDir, 'package.json'),
  );
  copyInto(path.join(standaloneDir, '.next'), path.join(gatewayDir, '.next'));
  copyInto(
    path.join(standaloneDir, 'node_modules'),
    path.join(gatewayDir, 'node_modules'),
  );
  copyInto(
    path.join(root, '.next', 'static'),
    path.join(gatewayDir, '.next', 'static'),
  );
  copyInto(path.join(root, 'public'), path.join(gatewayDir, 'public'));
  // Drizzle resolves the migrations folder relative to the working directory,
  // which is the gateway root at runtime.
  copyInto(
    migrationsDir,
    path.join(gatewayDir, 'lib', 'server', 'storage', 'migrations'),
  );

  console.log(`Gateway assembled at ${path.relative(root, gatewayDir)}`);
};

/**
 * The page the backend window renders.
 *
 * Browser target and IIFE, unlike the node/CommonJS pair above: it is loaded
 * with a plain `<script src>` from `file://`, where an ES module would be
 * fetched under CORS rules no file can satisfy. React and @lobehub/ui are
 * bundled in, because there is no `node_modules` next to the page at runtime.
 */
const bundlePage = (): void => {
  execFileSync(
    bunBinary(),
    [
      'build',
      path.join(root, 'electron', 'backend.tsx'),
      '--outfile',
      path.join(appDir, 'backend.js'),
      '--target',
      'browser',
      '--format',
      'iife',
      // React picks its JSX runtime from `process.env.NODE_ENV`, which a
      // browser bundle has no `process` to read it from. `--production` is what
      // makes bun inline the value: `--define` alone is not enough, since some
      // bun versions still resolve `react/jsx-runtime` to the development one
      // and the page then dies on `jsxDEV is not a function`. It minifies too,
      // which is wanted here anyway.
      '--production',
    ],
    { cwd: root, stdio: 'inherit' },
  );
};

const bundleElectron = () => {
  fs.rmSync(appDir, { force: true, recursive: true });
  fs.mkdirSync(appDir, { recursive: true });

  const bundle = (entry: string, outfile: string): void => {
    execFileSync(
      bunBinary(),
      [
        'build',
        path.join(root, 'electron', entry),
        '--outfile',
        path.join(appDir, outfile),
        '--target',
        'node',
        // CommonJS, not the default ESM: Electron loads a preload script as
        // CommonJS, so ESM syntax there would never run at all.
        '--format',
        'cjs',
        // Electron itself is provided by the app binary, not by the bundle.
        '--external',
        'electron',
      ],
      { cwd: root, stdio: 'inherit' },
    );
  };

  bundle('main.ts', 'main.js');
  // The window that picks a backend is a bundled page with a sandboxed
  // preload, so it needs both halves next to the main process.
  bundle('preload.ts', 'preload.js');
  bundlePage();

  const { author, description, version } = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as { author: string; description: string; version: string };

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        author,
        description,
        main: 'main.js',
        name: 'codebuddy2api-desktop',
        private: true,
        version,
      },
      null,
      2,
    )}\n`,
  );

  // Both menu bar icons come along: macOS asks for the template, everything
  // else for the app's own icon — and each is read from next to the bundled
  // main process, so neither can come from `electron/resources`, which is only
  // electron-builder's buildResources and never reaches the packaged app.
  for (const icon of ['tray.png', 'tray-template.png']) {
    copyInto(path.join(resourcesDir, icon), path.join(appDir, icon));
  }
  copyInto(
    path.join(root, 'electron', 'backend.html'),
    path.join(appDir, 'backend.html'),
  );

  console.log(`Electron main bundled at ${path.relative(root, appDir)}`);
};

const readElectronVersion = () => {
  const manifest = path.join(root, 'node_modules', 'electron', 'package.json');

  requirePath(manifest, 'Run `bun install` before building the desktop app.');

  return JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string };
};

/**
 * The gateway runs on Electron's Node, whose ABI differs from the Node the
 * standalone output was traced against, so `better-sqlite3` has to be compiled
 * against Electron's headers. Skipping this makes every storage call fail at
 * startup with an invalid module version error.
 */
const rebuildNativeModules = () => {
  const { version } = readElectronVersion();

  runBin('electron-rebuild', [
    '--version',
    version,
    '--module-dir',
    gatewayDir,
    '--only',
    'better-sqlite3',
    '--force',
  ]);

  console.log(`Rebuilt native modules against Electron ${version}`);
};

const packageDesktop = (forwarded: string[], devIcon: boolean) => {
  requirePath(
    builderConfig,
    'The electron-builder configuration is missing from electron/.',
  );
  fs.mkdirSync(resourcesDir, { recursive: true });

  /**
   * The development icon, given to electron-builder on the command line rather
   * than through a second configuration file: everything else about the build is
   * the release build's, and the icon is the only thing that differs. One 1024
   * pixel PNG serves all three platforms — electron-builder makes the `icns` and
   * the `ico` macOS and Windows ask for out of it.
   */
  const iconPath = path.join(appDir, DEV_ICON_FILENAME);

  if (devIcon) {
    // An icon electron-builder cannot read is not an error to it: it falls back
    // to the release icon it finds in `buildResources`, and out comes an install
    // that nothing tells apart from a release — which is the one thing this
    // icon exists to prevent.
    requirePath(
      iconPath,
      'The development icon is missing from the app directory.',
    );
  }

  const iconArguments = devIcon
    ? [
        '-c.mac.icon=' + iconPath,
        '-c.win.icon=' + iconPath,
        '-c.linux.icon=' + iconPath,
      ]
    : [];

  runBin('electron-builder', [
    '--config',
    builderConfig,
    ...iconArguments,
    '--publish',
    'never',
    ...forwarded,
  ]);
};

const { devIcon, forwarded, prepareOnly } = parseArguments(
  process.argv.slice(2),
);

assembleGateway();
bundleElectron();
rebuildNativeModules();

// After the bundle, which empties the directory the icon is copied into. The
// icon is a committed picture — scripts/dev-icon.ts says how it is drawn — so a
// build hands electron-builder and `electron .` a file instead of asking either
// of them to rasterise an SVG.
if (devIcon) {
  copyInto(
    path.join(resourcesDir, DEV_ICON_FILENAME),
    path.join(appDir, DEV_ICON_FILENAME),
  );
}

if (!prepareOnly) {
  packageDesktop(forwarded, devIcon);
}
