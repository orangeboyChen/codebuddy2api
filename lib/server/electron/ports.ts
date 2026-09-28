import { connect, createServer } from 'node:net';

export const DEFAULT_GATEWAY_PORT = 8001;
/**
 * How long a connect probe waits before it calls a port taken. Anything that
 * accepts is accepted at once, so this only ever catches a stalled connect.
 */
export const CONNECT_TIMEOUT_MS = 1_000;
/**
 * Ports below this one need privileges a desktop app launched from Finder or
 * the Start menu does not have, so accepting one would only ever produce a
 * gateway that cannot bind it.
 */
export const MIN_PORT = 1024;
export const MAX_PORT = 65_535;

export type PortProbe = (port: number) => Promise<boolean>;

/**
 * Connects to see whether something is already serving a port.
 *
 * Not `listen`, and not on its own: with `SO_REUSEADDR` a loopback bind
 * succeeds even while another process serves the same port through the wildcard
 * address — a Docker deployment that already owns `8001`, say. Handing the
 * gateway such a port would leave it unable to bind it, and worse, would let
 * the health check be answered by whatever else is listening there: the app
 * would report a gateway it does not own and open a console served by someone
 * else's build.
 */
export const probePortServed = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });

    const done = (served: boolean): void => {
      socket.destroy();
      resolve(served);
    };

    // Nothing is listening: refused at once. Otherwise the connection is
    // accepted, and a stalled one is a port to stay away from as well.
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      done(true);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });

/**
 * Binds a loopback socket to check whether a port can be taken. The socket is
 * released immediately, so a concurrent listener can still grab the port
 * between this probe and the gateway binding it; `startGateway` reports that
 * as a failed startup instead of silently pointing the window at a gateway it
 * does not own.
 */
export const probePortBindable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen({ host: '127.0.0.1', port });
  });

/** Free means nothing serves it yet, and the app could bind it. */
export const probePortFree = async (port: number): Promise<boolean> =>
  !(await probePortServed(port)) && probePortBindable(port);

export interface AvailablePortOptions {
  attempts?: number;
  preferred?: number;
  probe?: PortProbe;
}

/**
 * A desktop install often coexists with a Docker deployment, which already
 * owns `8001`. Walking upwards keeps the app usable in that case instead of
 * failing to start.
 */
export const findAvailablePort = async (
  options: AvailablePortOptions = {},
): Promise<number> => {
  const preferred = options.preferred ?? DEFAULT_GATEWAY_PORT;
  const attempts = options.attempts ?? 20;
  const probe = options.probe ?? probePortFree;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferred + offset;

    // Walking past the top of the range can only produce ports `listen`
    // rejects outright, so the walk stops at the last real one.
    if (candidate > MAX_PORT) {
      break;
    }

    if (await probe(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `no free loopback port found in range ${preferred}-${Math.min(preferred + attempts - 1, MAX_PORT)}`,
  );
};

/**
 * Reads a port out of a value that came from outside the app — an environment
 * variable, a saved settings file, a request body — and falls back when it is
 * not a whole number the gateway could actually bind.
 *
 * `parseInt` alone would read the leading digits of `1e3` or `80abc` and call
 * them a port, so a string only counts when it is nothing but digits.
 */
export const normalizePort = (
  value: unknown,
  fallback: number = DEFAULT_GATEWAY_PORT,
): number => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const parsed =
    typeof value === 'number'
      ? value
      : /^\d{1,5}$/.test(trimmed)
        ? Number.parseInt(trimmed, 10)
        : Number.NaN;

  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    return fallback;
  }

  return parsed;
};

/**
 * Lets the desktop port be pinned, for example to keep a firewall rule or a
 * client config pointed at a fixed address.
 */
export const resolvePreferredPort = (
  env: NodeJS.ProcessEnv,
  fallback: number = DEFAULT_GATEWAY_PORT,
): number => {
  const raw = env.CODEBUDDY_DESKTOP_PORT?.trim();

  return raw ? normalizePort(raw, fallback) : fallback;
};
