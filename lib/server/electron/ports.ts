import { createServer } from 'node:net';

export const DEFAULT_GATEWAY_PORT = 8001;

export type PortProbe = (port: number) => Promise<boolean>;

/**
 * Binds a loopback socket to check whether a port is free. The socket is
 * released immediately, so a concurrent listener can still grab the port
 * between this probe and the gateway binding it; `startGateway` reports that
 * as a failed startup instead of silently pointing the window at a gateway it
 * does not own.
 */
export const probePortFree = (port: number): Promise<boolean> =>
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

    if (await probe(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `no free loopback port found in range ${preferred}-${preferred + attempts - 1}`,
  );
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

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return fallback;
  }

  return parsed;
};
