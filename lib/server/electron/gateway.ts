import { spawn as spawnProcess } from 'node:child_process';
import path from 'node:path';

import { ADMIN_UPSTREAM_ENV } from '../admin/upstream';
import { DESKTOP_CONSOLE_TOKEN_ENV } from './console-token';
import { DESKTOP_DEVICE_TOKEN_ENV } from './device-token';
import { DESKTOP_MODE_ENV, DESKTOP_USER_DATA_ENV } from './settings';
import type { DesktopPaths } from './paths';

export type GatewayEnvPaths = Pick<
  DesktopPaths,
  'credentialsDir' | 'dataDir' | 'sqlitePath' | 'userDataDir'
>;

export interface GatewayStream {
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
}

export interface GatewayProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error' | 'exit', listener: (...args: unknown[]) => void): unknown;
  pid?: number;
  stderr: GatewayStream | null;
  stdout: GatewayStream | null;
}

export interface GatewaySpawnOptions {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type GatewaySpawn = (options: GatewaySpawnOptions) => GatewayProcess;

export type HealthRequest = (url: string) => Promise<boolean>;

export interface HealthWaitOptions {
  intervalMs?: number;
  request?: HealthRequest;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  url: string;
}

export interface GatewayHandle {
  /**
   * Resolves once the gateway's process has gone.
   *
   * `stop()` is a signal, not an exit: a process that has been asked to stop
   * still holds the port it was serving until it has actually finished. A
   * restart that does not wait for it finds its own dying gateway answering,
   * and reads that as the port being taken by something else.
   */
  exited: Promise<void>;
  port: number;
  stop: () => void;
  url: string;
}

export interface GatewayEnvOptions {
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * The token the console this gateway serves answers to. Nothing without it
   * gets a page: see `console-token`.
   */
  consoleToken?: string | null;
  /**
   * The token the deployment this console shows data from handed this app, to be
   * sent with everything forwarded there: see `device-token`.
   */
  deviceToken?: string | null;
  encryptionKey: string;
  paths: GatewayEnvPaths;
  port: number;
  /**
   * The deployment whose data the console shows. Null — the usual case — when
   * this install serves its own.
   */
  upstream?: string | null;
}

export interface StartGatewayOptions {
  env: NodeJS.ProcessEnv;
  gatewayDir: string;
  log?: (message: string) => void;
  nodePath: string;
  /**
   * Called when the gateway dies on its own — including long after it became
   * healthy, which is a crash rather than a failed start. Not called when the
   * app stopped it.
   */
  onUnexpectedExit?: (error: Error) => void;
  /**
   * The process, the moment it exists — before it is healthy, and before there
   * is a handle to stop it. An app that quits while the gateway is still coming
   * up has nothing else that could take the child with it.
   */
  onChild?: (child: GatewayProcess) => void;
  port: number;
  spawn?: GatewaySpawn;
  timeoutMs?: number;
  waitForHealth?: (options: HealthWaitOptions) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 2_000;
/**
 * How long one page is given to answer, which is longer than a health check
 * gets: a compile is not a read, and a request cut short mid-compile is a
 * compile started again from nothing on the next one.
 */
const CONSOLE_PAGE_REQUEST_TIMEOUT_MS = 30_000;

const defaultLog = (message: string): void => {
  console.log(`[gateway] ${message}`);
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultRequest: HealthRequest = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  return response.ok;
};

const defaultSpawn: GatewaySpawn = (options) =>
  spawnProcess(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

/**
 * The gateway is the same Next.js standalone server the Docker image runs, so
 * it is configured the same way: through environment variables. Values already
 * present in the environment win, which lets a desktop install reuse an
 * encryption key that was provisioned ahead of time.
 *
 * Storage is the exception: a desktop install is always sqlite, because it is
 * the only backend that needs nothing but the `userData` directory, and there
 * is no second process to share a database with.
 */
export const buildGatewayEnv = (
  options: GatewayEnvOptions,
): NodeJS.ProcessEnv => {
  // `NODE_ENV` is read-only once Next has typed `process.env`, so it goes in
  // with the spread instead of an assignment.
  const env: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? process.env),
    NODE_ENV: 'production',
  };

  // A desktop install serves its own console; nothing on the LAN should be
  // able to reach it.
  env.HOSTNAME = '127.0.0.1';
  env.PORT = String(options.port);
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.CODEBUDDY_STORAGE_FILE_DIR ??= options.paths.dataDir;
  env.CODEBUDDY_CREDENTIALS_DIR ??= options.paths.credentialsDir;
  env.CODEBUDDY_STORAGE_SQLITE_PATH ??= options.paths.sqlitePath;
  env.CODEBUDDY_STORAGE_ENCRYPTION_KEY ??= options.encryptionKey;
  env[DESKTOP_MODE_ENV] = '1';
  env[DESKTOP_USER_DATA_ENV] = options.paths.userDataDir;
  env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
  // An inherited Postgres URL is dropped rather than ignored: the storage layer
  // falls back to Postgres whenever one is in the environment, so leaving it
  // here would put the desktop data somewhere the console cannot explain.
  delete env.CODEBUDDY_STORAGE_PG_URL;
  delete env.DATABASE_URL;

  // Only the data comes from a deployment, never the console: the pages stay
  // this build's, and `/admin-api` and `/v1` are forwarded. Dropped rather than
  // emptied when there is none, so a stale value in the parent environment
  // cannot turn a local install into someone else's console.
  if (options.upstream) {
    env[ADMIN_UPSTREAM_ENV] = options.upstream;
  } else {
    delete env[ADMIN_UPSTREAM_ENV];
  }

  // Dropped rather than emptied when there is none, so a token left behind in
  // the environment cannot silently decide who a console answers to.
  if (options.consoleToken?.trim()) {
    env[DESKTOP_CONSOLE_TOKEN_ENV] = options.consoleToken.trim();
  } else {
    delete env[DESKTOP_CONSOLE_TOKEN_ENV];
  }

  // Dropped rather than emptied for the same reason: a stale token would send
  // one deployment's introduction to another.
  if (options.deviceToken?.trim()) {
    env[DESKTOP_DEVICE_TOKEN_ENV] = options.deviceToken.trim();
  } else {
    delete env[DESKTOP_DEVICE_TOKEN_ENV];
  }

  return env;
};

export type ConsolePageRequest = (
  url: string,
  headers: Record<string, string>,
) => Promise<boolean>;

export interface ConsolePageWaitOptions {
  /**
   * What the console is asked with, which is how the window asks: without the
   * token the console answers 404 to everything, so a request that left it out
   * would wait for a page that is never going to come.
   */
  headers?: Record<string, string>;
  intervalMs?: number;
  request?: ConsolePageRequest;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  url: string;
}

const defaultConsoleRequest: ConsolePageRequest = async (url, headers) => {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(CONSOLE_PAGE_REQUEST_TIMEOUT_MS),
  });

  return response.ok;
};

/**
 * Asks the console for the page the window is about to be sent to, and waits
 * until it answers.
 *
 * `/health` is answered by the server and not by the pages. A development run
 * serves the console out of the repository, where the first page is a compile
 * and not a read — so health answers seconds before `/dashboard` exists at all,
 * and a window sent to it in between is a blank one, which reads as an app that
 * never opened a console.
 *
 * Answering false is not a failure to report: the window is opened either way,
 * and then says whatever it has to say about a console that will not come up.
 */
export const waitForConsolePage = async (
  options: ConsolePageWaitOptions,
): Promise<boolean> => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request = options.request ?? defaultConsoleRequest;
  const sleep = options.sleep ?? defaultSleep;
  const headers = options.headers ?? {};
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const answered = await request(options.url, headers).catch(() => false);

    if (answered) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await sleep(intervalMs);
  }
};

/**
 * Polls `/health` until the gateway answers. The server migrates its database
 * on boot, so the first answer can take several seconds on a cold install.
 */
export const waitForGatewayHealth = async (
  options: HealthWaitOptions,
): Promise<boolean> => {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const request = options.request ?? defaultRequest;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const healthy = await request(options.url).catch(() => false);

    if (healthy) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await sleep(intervalMs);
  }
};

const pipeToLog = (
  stream: GatewayStream | null,
  log: (message: string) => void,
): void => {
  if (!stream) {
    return;
  }

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const line = String(chunk).trim();

    if (line) {
      log(line);
    }
  });
};

/**
 * Runs the bundled gateway under Electron's own Node — `ELECTRON_RUN_AS_NODE`
 * turns the app binary into a plain Node process — and resolves once the
 * gateway reports healthy. The child is detached from the window: it keeps
 * serving `/v1/*` while the console window is closed, and is killed when the
 * app quits.
 */
export const startGateway = async (
  options: StartGatewayOptions,
): Promise<GatewayHandle> => {
  const log = options.log ?? defaultLog;
  const spawn = options.spawn ?? defaultSpawn;
  const waitForHealth = options.waitForHealth ?? waitForGatewayHealth;
  const url = `http://127.0.0.1:${options.port}`;
  // The one path a desktop install answers outside its own window: the console's
  // pages are 404 to everything else, so a gateway that is already serving would
  // be reported as one that never became healthy — and stopped, and the failure
  // shown, sixty seconds later.
  const healthUrl = `${url}/health`;
  const child = spawn({
    args: [path.join(options.gatewayDir, 'server.js')],
    command: options.nodePath,
    cwd: options.gatewayDir,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  pipeToLog(child.stdout, log);
  pipeToLog(child.stderr, log);

  // The other end of `stop()`: a promise that settles when the process is
  // really gone, which is when the port it held is free again.
  const gone = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });

  options.onChild?.(child);

  let stopped = false;
  let healthy = false;
  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    child.kill();
  };

  // Only an exit after the gateway was healthy is worth reporting: a child
  // that dies on the way up is already reported by the rejection below, and
  // the app would otherwise show both dialogs.
  const notifyExit = (error: Error): void => {
    if (healthy && !stopped) {
      options.onUnexpectedExit?.(error);
    }
  };

  const exited = new Promise<never>((_resolve, reject) => {
    child.on('error', (...args: unknown[]) => {
      const error =
        args[0] instanceof Error
          ? args[0]
          : new Error(`gateway process failed to start: ${String(args[0])}`);

      notifyExit(error);
      reject(error);
    });
    child.on('exit', (...args: unknown[]) => {
      const [code] = args as [number | null];

      const error = healthy
        ? new Error(`gateway process exited with code ${code}`)
        : new Error(
            `gateway process exited before it became healthy (${code})`,
          );

      notifyExit(error);
      reject(error);
    });
  });

  // The child also exits long after startup — when the app quits, or when it
  // crashes. Keep that rejection handled so it never surfaces later as an
  // unhandled rejection.
  exited.catch(() => {});

  try {
    const healthyInTime = await Promise.race([
      waitForHealth({ timeoutMs: options.timeoutMs, url: healthUrl }),
      exited,
    ]);

    if (!healthyInTime) {
      throw new Error(
        `gateway did not become healthy within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      );
    }

    healthy = true;
  } catch (error) {
    stop();
    throw error;
  }

  return { exited: gone, port: options.port, stop, url };
};
