import { createServer } from 'node:net';

import {
  DEFAULT_GATEWAY_PORT,
  findAvailablePort,
  probePortFree,
  resolvePreferredPort,
} from '@/lib/server/electron/ports';

const listenOnce = async (): Promise<{ close: () => void; port: number }> => {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('expected a port from the ephemeral listener');
  }

  return {
    close: () => {
      server.close();
    },
    port: address.port,
  };
};

describe('probePortFree', () => {
  it('reports a busy port as taken and a closed one as free', async () => {
    const listener = await listenOnce();

    await expect(probePortFree(listener.port)).resolves.toBe(false);

    listener.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    await expect(probePortFree(listener.port)).resolves.toBe(true);
  });
});

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    const probe = vi.fn().mockResolvedValue(true);

    await expect(findAvailablePort({ probe })).resolves.toBe(
      DEFAULT_GATEWAY_PORT,
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('walks to the next free port', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await expect(findAvailablePort({ probe })).resolves.toBe(
      DEFAULT_GATEWAY_PORT + 2,
    );
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('gives up instead of handing out a port in use', async () => {
    const probe = vi.fn().mockResolvedValue(false);

    await expect(
      findAvailablePort({ attempts: 3, preferred: 9000, probe }),
    ).rejects.toThrow('9000-9002');
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

// Next's generated environment types mark `NODE_ENV` as required.
const asEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...overrides,
});

describe('resolvePreferredPort', () => {
  it('falls back to the default port when nothing is pinned', () => {
    expect(resolvePreferredPort(asEnv())).toBe(DEFAULT_GATEWAY_PORT);
  });

  it('honors a pinned port', () => {
    expect(
      resolvePreferredPort(asEnv({ CODEBUDDY_DESKTOP_PORT: '9001' })),
    ).toBe(9001);
  });

  it.each(['', ' ', 'not-a-port', '0', '70000'])(
    'ignores the invalid pin %j',
    (value) => {
      expect(
        resolvePreferredPort(asEnv({ CODEBUDDY_DESKTOP_PORT: value })),
      ).toBe(DEFAULT_GATEWAY_PORT);
    },
  );
});
