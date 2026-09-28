import fs from 'node:fs';
import path from 'node:path';

export interface GatewayNodeOptions {
  /** A directory the link may be written to, such as Electron's `temp`. */
  directory: string;
  /** The app's own binary: the Node the gateway runs on. */
  executable: string;
  /** Defaults to `fs.readlinkSync`, overridable so tests stay off the disk. */
  readlink?: (target: string) => string;
  /** Defaults to `fs.rmSync`, overridable so tests stay off the disk. */
  remove?: (target: string) => void;
  platform?: NodeJS.Platform;
  /** Defaults to `fs.symlinkSync`, overridable so tests stay off the disk. */
  symlink?: (executable: string, target: string) => void;
}

/** The name the link is written under, inside `directory`. */
export const GATEWAY_NODE = 'codebuddy2api-gateway-node';

/**
 * The executable the gateway is started with.
 *
 * The gateway renames itself the moment Next takes over — `process.title`
 * becomes `next-server (v…)`, from inside Next's own `startServer` — and macOS
 * hands a Dock tile to a process it can attribute to an `.app` bundle that
 * renames itself. The app would then be two apps: the menu bar item the install
 * is meant to have, and beside it "Electron" in a development build, the app's
 * own name in an installed one, neither of which opens anything. The same
 * binary reached through a link that lives outside the bundle is a background
 * process to macOS: no tile, no entry in the app switcher, and nothing else
 * about the child changes.
 *
 * Everywhere else the binary is used as it is: no other desktop gives a child a
 * window of its own to appear in.
 */
export const resolveGatewayNodePath = (options: GatewayNodeOptions): string => {
  const { directory, executable } = options;

  if ((options.platform ?? process.platform) !== 'darwin') {
    return executable;
  }

  const link = path.join(directory, GATEWAY_NODE);
  const readlink = options.readlink ?? fs.readlinkSync;
  const remove =
    options.remove ??
    ((target: string) => {
      // Only a link is removed: a file or a directory that happens to sit under
      // the same name in a shared temporary directory is not this app's to
      // delete, and the binary is used as it is instead.
      if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
        fs.rmSync(target, { force: true });
      }
    });
  const symlink = options.symlink ?? fs.symlinkSync;

  // Only a link that leads to this very binary is reused: an app that moved,
  // or one that was replaced by an upgrade, leaves one that leads somewhere
  // else — or nowhere at all.
  const reusable = (): string | null => {
    try {
      return readlink(link) === executable ? link : null;
    } catch {
      return null;
    }
  };

  if (reusable()) {
    return link;
  }

  try {
    remove(link);
    symlink(executable, link);
  } catch {
    // A directory the app cannot write to costs a Dock tile, not the gateway.
    return executable;
  }

  return reusable() ?? executable;
};
