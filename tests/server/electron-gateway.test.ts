import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildGatewayEnv,
  startGateway,
  waitForGatewayHealth,
  type GatewayProcess,
  type GatewayStream,
} from '@/lib/server/electron/gateway';

const createStream = () => {
  const listeners: Array<(chunk: string | Buffer) => void> = [];
  let encoding: BufferEncoding | '' = '';
  const stream: GatewayStream = {
    on: (_event, listener) => {
      listeners.push(listener);
    },
    setEncoding: (value) => {
      encoding = value;
    },
  };

  return {
    emit: (chunk: string) => {
      listeners.forEach((listener) => listener(chunk));
    },
    encoding: () => encoding,
    stream,
  };
};

const createChild = () => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const stdout = createStream();
  const stderr = createStream();
  let killCount = 0;
  const child: GatewayProcess = {
    kill: () => {
      killCount += 1;

      return true;
    },
    on: (event, listener) => {
      const listeners = handlers.get(event) ?? [];

      listeners.push(listener);
      handlers.set(event, listeners);
    },
    pid: 4242,
    stderr: stderr.stream,
    stdout: stdout.stream,
  };

  return {
    child,
    emit: (event: 'error' | 'exit', ...args: unknown[]) => {
      (handlers.get(event) ?? []).forEach((listener) => listener(...args));
    },
    killCount: () => killCount,
    stderr,
    stdout,
  };
};

const paths = {
  credentialsDir: '/user-data/credentials',
  dataDir: '/user-data/data',
  sqlitePath: '/user-data/data/storage.sqlite',
  userDataDir: '/user-data',
};

// Next's generated environment types mark `NODE_ENV` as required.
const asEnv = (
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...overrides });

describe('buildGatewayEnv', () => {
  it('defaults a desktop install to encrypted sqlite on loopback', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({ UNRELATED: 'kept' }),
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.UNRELATED).toBe('kept');
    expect(env.PORT).toBe('8123');
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.NODE_ENV).toBe('production');
    expect(env.NEXT_TELEMETRY_DISABLED).toBe('1');
    expect(env.CODEBUDDY_DESKTOP).toBe('1');
    expect(env.CODEBUDDY_DESKTOP_USER_DATA_DIR).toBe('/user-data');
    expect(env.CODEBUDDY_STORAGE_BACKEND).toBe('sqlite');
    expect(env.CODEBUDDY_STORAGE_ENCRYPTION_KEY).toBe('secret');
    expect(env.CODEBUDDY_STORAGE_SQLITE_PATH).toBe(paths.sqlitePath);
    expect(env.CODEBUDDY_STORAGE_FILE_DIR).toBe(paths.dataDir);
    expect(env.CODEBUDDY_CREDENTIALS_DIR).toBe(paths.credentialsDir);
  });

  it.each([
    { CODEBUDDY_STORAGE_BACKEND: 'file' },
    { CODEBUDDY_STORAGE_BACKEND: 'pg' },
    { DATABASE_URL: 'postgres://localhost' },
    { CODEBUDDY_STORAGE_PG_URL: 'postgres://localhost' },
  ])('stays on sqlite despite %j', (overrides) => {
    const env = buildGatewayEnv({
      baseEnv: asEnv(overrides),
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_STORAGE_BACKEND).toBe('sqlite');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CODEBUDDY_STORAGE_PG_URL).toBeUndefined();
  });

  it('keeps an encryption key that is already configured', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({ CODEBUDDY_STORAGE_ENCRYPTION_KEY: 'from-env' }),
      encryptionKey: 'generated',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_STORAGE_ENCRYPTION_KEY).toBe('from-env');
  });

  it('keeps storage paths that are already configured', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({
        CODEBUDDY_CREDENTIALS_DIR: '/elsewhere/credentials',
        CODEBUDDY_STORAGE_FILE_DIR: '/elsewhere/data',
        CODEBUDDY_STORAGE_SQLITE_PATH: '/elsewhere/storage.sqlite',
      }),
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_STORAGE_FILE_DIR).toBe('/elsewhere/data');
    expect(env.CODEBUDDY_CREDENTIALS_DIR).toBe('/elsewhere/credentials');
    expect(env.CODEBUDDY_STORAGE_SQLITE_PATH).toBe('/elsewhere/storage.sqlite');
  });

  // The token is how the shell tells the gateway which requests are its own
  // window's. It is made up for one run, so it is passed down rather than read
  // back out of anything.
  it('hands the gateway the console token it made up for this run', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({}),
      consoleToken: 'a-console-token',
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_DESKTOP_CONSOLE_TOKEN).toBe('a-console-token');
  });

  // Not a desktop install: a deployment someone runs themselves is meant to be
  // reached in a browser, so nothing is asked of it.
  it('sets no console token when the shell did not make one', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({ CODEBUDDY_DESKTOP_CONSOLE_TOKEN: 'stale' }),
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_DESKTOP_CONSOLE_TOKEN).toBeUndefined();
  });

  // The token the deployment handed this app: the gateway is what forwards it,
  // so it is the gateway that has to be told.
  it('hands the gateway the token the user approved this app with', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({}),
      deviceToken: 'a-device-token',
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_DESKTOP_DEVICE_TOKEN).toBe('a-device-token');
  });

  // Not approved, or signed out: nothing is carried to the deployment, and a
  // token left over from a run that ended is not carried either.
  it('sets no device token when this app was not approved', () => {
    const env = buildGatewayEnv({
      baseEnv: asEnv({ CODEBUDDY_DESKTOP_DEVICE_TOKEN: 'stale' }),
      encryptionKey: 'secret',
      paths,
      port: 8123,
    });

    expect(env.CODEBUDDY_DESKTOP_DEVICE_TOKEN).toBeUndefined();
  });

  it('inherits the real environment when none is handed in', () => {
    vi.stubEnv('CODEBUDDY_DESKTOP_TEST_INHERITED', '1');

    try {
      const env = buildGatewayEnv({
        encryptionKey: 'secret',
        paths,
        port: 8123,
      });

      expect(env.CODEBUDDY_DESKTOP_TEST_INHERITED).toBe('1');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('waitForGatewayHealth', () => {
  it('resolves as soon as the gateway answers', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForGatewayHealth({ request, sleep, url: 'http://127.0.0.1:1' }),
    ).resolves.toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until the gateway answers', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForGatewayHealth({ request, sleep, url: 'http://127.0.0.1:1' }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('treats a failed request as not healthy', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForGatewayHealth({ request, sleep, url: 'http://127.0.0.1:1' }),
    ).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up once the deadline has passed', async () => {
    const request = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForGatewayHealth({
        request,
        sleep,
        timeoutMs: 0,
        url: 'http://127.0.0.1:1',
      }),
    ).resolves.toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// The default helpers talk to the real world — a real child process and a real
// `fetch` — so they get a script on disk instead of a mock.
const createGatewayDir = (script: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-defaults-'));

  fs.writeFileSync(path.join(dir, 'server.js'), script);

  return dir;
};

describe('gateway defaults', () => {
  it('polls /health with the default request and sleep helpers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValue({ ok: true } as Response);

    try {
      await expect(
        waitForGatewayHealth({
          intervalMs: 1,
          url: 'http://127.0.0.1:1/health',
        }),
      ).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:1/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('spawns a real child process and logs its output to the console', async () => {
    const gatewayDir = createGatewayDir(
      'console.log("booted");\nsetInterval(() => {}, 1000);\n',
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const handle = await startGateway({
        env: asEnv(),
        gatewayDir,
        nodePath: process.execPath,
        port: 45_671,
        waitForHealth: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 250);
          });

          return true;
        },
      });

      expect(handle.url).toBe('http://127.0.0.1:45671');
      expect(logSpy).toHaveBeenCalledWith('[gateway] booted');
      handle.stop();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(gatewayDir, { force: true, recursive: true });
    }
  });

  it('gives up with the default health check when nothing answers', async () => {
    const gatewayDir = createGatewayDir('setInterval(() => {}, 1000);\n');

    try {
      await expect(
        startGateway({
          env: asEnv(),
          gatewayDir,
          nodePath: process.execPath,
          port: 45_672,
          timeoutMs: 50,
        }),
      ).rejects.toThrow('did not become healthy within 50ms');
    } finally {
      fs.rmSync(gatewayDir, { force: true, recursive: true });
    }
  });
});

describe('startGateway', () => {
  it('runs the bundled server under Electron’s node and waits for it', async () => {
    const { child } = createChild();
    const spawn = vi.fn(() => child);
    const log = vi.fn();
    const handle = await startGateway({
      env: asEnv({ CODEBUDDY_STORAGE_BACKEND: 'sqlite' }),
      gatewayDir: '/app/gateway',
      log,
      nodePath: '/Electron',
      port: 8001,
      spawn,
      waitForHealth: async () => true,
    });

    expect(spawn).toHaveBeenCalledWith({
      args: ['/app/gateway/server.js'],
      command: '/Electron',
      cwd: '/app/gateway',
      env: {
        CODEBUDDY_STORAGE_BACKEND: 'sqlite',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'test',
      },
    });
    expect(handle.port).toBe(8001);
    expect(handle.url).toBe('http://127.0.0.1:8001');
    expect(log).not.toHaveBeenCalled();
  });

  it('waits on the health check, and not on the console it is asking about', async () => {
    const { child } = createChild();
    const spawn = vi.fn(() => child);
    const waitForHealth = vi.fn(async () => true);

    await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn,
      waitForHealth,
    });

    // A desktop install answers its pages with 404 to anything that is not the
    // window, so the origin is not a health check: polling it would wait out the
    // timeout and stop a gateway that was up all along.
    expect(waitForHealth).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://127.0.0.1:8001/health' }),
    );
  });

  it('forwards gateway output to the log', async () => {
    const { child, stderr, stdout } = createChild();
    const log = vi.fn();

    await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      log,
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    stdout.emit('ready\n');
    stderr.emit('boom\n');

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('ready');
    expect(log).toHaveBeenCalledWith('boom');
    expect(stdout.encoding()).toBe('utf8');
    expect(stderr.encoding()).toBe('utf8');
  });

  it('drops the blank lines a stream arrives in', async () => {
    const { child, stdout } = createChild();
    const log = vi.fn();

    await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      log,
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    stdout.emit('\n');

    expect(log).not.toHaveBeenCalled();
  });

  it('stops the gateway when it never becomes healthy', async () => {
    const { child, emit, killCount } = createChild();

    await expect(
      startGateway({
        env: asEnv(),
        gatewayDir: '/app/gateway',
        nodePath: '/Electron',
        port: 8001,
        spawn: () => child,
        waitForHealth: async () => false,
      }),
    ).rejects.toThrow('did not become healthy');
    expect(killCount()).toBe(1);

    // A late exit must not turn into an unhandled rejection.
    emit('exit', 1);
    await Promise.resolve();
  });

  it('rejects when the process exits before it is healthy', async () => {
    const { child, emit, killCount } = createChild();
    const waitForHealth = vi.fn(
      () => new Promise<boolean>(() => undefined) as Promise<boolean>,
    );
    const pending = startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth,
    });

    emit('exit', 3);

    await expect(pending).rejects.toThrow(
      'gateway process exited before it became healthy (3)',
    );
    expect(killCount()).toBe(1);
  });

  it('rejects with the error the process failure carried', async () => {
    const { child, emit } = createChild();
    const failure = new Error('ENOENT');
    const pending = startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: () => new Promise<boolean>(() => undefined),
    });

    emit('error', failure);

    await expect(pending).rejects.toBe(failure);
  });

  it('rejects a non-error spawn failure', async () => {
    const { child, emit } = createChild();
    const pending = startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: () => new Promise<boolean>(() => undefined),
    });

    emit('error', 'spawn failed');

    await expect(pending).rejects.toThrow('spawn failed');
  });

  it('reports an exit long after the gateway became healthy', async () => {
    const { child, emit } = createChild();
    const onUnexpectedExit = vi.fn();
    const handle = await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      onUnexpectedExit,
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    emit('exit', 9);
    await Promise.resolve();

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(
      (onUnexpectedExit.mock.calls[0]?.[0] as Error | undefined)?.message,
    ).toBe('gateway process exited with code 9');
    expect(handle.port).toBe(8001);
  });

  it('does not report an exit the app asked for', async () => {
    const { child, emit } = createChild();
    const onUnexpectedExit = vi.fn();
    const handle = await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      onUnexpectedExit,
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    handle.stop();
    emit('exit', 0);
    await Promise.resolve();

    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('leaves a failed start to the rejection it already produces', async () => {
    const { child, emit } = createChild();
    const onUnexpectedExit = vi.fn();
    const pending = startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      onUnexpectedExit,
      port: 8001,
      spawn: () => child,
      waitForHealth: () => new Promise<boolean>(() => undefined),
    });

    emit('error', new Error('EACCES'));

    await expect(pending).rejects.toThrow('EACCES');
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('kills the gateway once, however often it is stopped', async () => {
    const { child, killCount } = createChild();
    const handle = await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    handle.stop();
    handle.stop();

    expect(killCount()).toBe(1);
  });

  it('tolerates a child without output streams', async () => {
    const child: GatewayProcess = {
      kill: () => true,
      on: () => undefined,
      pid: 1,
      stderr: null,
      stdout: null,
    };
    const handle = await startGateway({
      env: asEnv(),
      gatewayDir: '/app/gateway',
      nodePath: '/Electron',
      port: 8001,
      spawn: () => child,
      waitForHealth: async () => true,
    });

    expect(handle.port).toBe(8001);
  });
});
