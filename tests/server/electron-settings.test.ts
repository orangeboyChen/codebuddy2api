import fs from 'node:fs';
import path from 'node:path';

import {
  defaultDesktopSettings,
  desktopSettingsPath,
  isDesktopMode,
  isPinnedPort,
  normalizeDesktopBackend,
  normalizeDesktopPort,
  readDesktopSettings,
  resolveDesktopPreferredPort,
  writeDesktopSettings,
  type DesktopBackend,
} from '@/lib/server/electron/settings';
import { DEFAULT_GATEWAY_PORT } from '@/lib/server/electron/ports';

const root = path.join(process.cwd(), '.tmp-test-electron-settings');
const userDataDir = path.join(root, 'user-data');
const nestedDir = path.join(root, 'nested', 'user-data');

const resetRoot = (): void => {
  fs.rmSync(root, { force: true, recursive: true });
};

// Next's generated environment types mark `NODE_ENV` as required.
const asEnv = (
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...overrides });

describe('normalizeDesktopBackend', () => {
  it.each([
    {
      value: { mode: 'remote', url: 'https://api.example.com' },
      label: 'https',
    },
    {
      value: { mode: 'remote', url: 'http://192.168.1.9:8001' },
      label: 'plain http on the LAN',
    },
    {
      value: { mode: 'remote', url: 'https://api.example.com/' },
      label: 'a trailing slash',
    },
    {
      value: { mode: 'remote', url: '  https://api.example.com/base  ' },
      label: 'a sub-path',
    },
  ])('keeps $label', ({ value }) => {
    expect(normalizeDesktopBackend(value)).toEqual({
      mode: 'remote',
      url: (value.url as string).trim().replace(/\/+$/, ''),
    });
  });

  it.each([
    { value: undefined, why: 'missing' },
    { value: { mode: 'local' }, why: 'explicitly local' },
    { value: { mode: 'remote' }, why: 'a remote without an address' },
    { value: { mode: 'remote', url: '' }, why: 'an empty address' },
    { value: { mode: 'remote', url: 'not a url' }, why: 'a malformed address' },
    { value: { mode: 'remote', url: 'ftp://api.example.com' }, why: 'ftp' },
    { value: { mode: 'remote', url: 'file:///etc/passwd' }, why: 'a file url' },
    {
      value: { mode: 'nonsense', url: 'https://api.example.com' },
      why: 'an unknown mode',
    },
    { value: 'remote', why: 'not an object' },
    { value: [], why: 'an array' },
  ])('falls back to the local gateway on $why', ({ value }) => {
    expect(normalizeDesktopBackend(value)).toEqual({ mode: 'local' });
  });
});

describe('defaultDesktopSettings', () => {
  it('starts on the documented gateway port', () => {
    expect(defaultDesktopSettings()).toEqual({
      backend: { mode: 'local' },
      port: DEFAULT_GATEWAY_PORT,
    });
  });
});

describe('normalizeDesktopPort', () => {
  it.each([
    { value: '8001', expected: 8001 },
    { value: 8123, expected: 8123 },
    { value: 1024, expected: 1024 },
    { value: 65_535, expected: 65_535 },
    { value: '  8100  ', expected: 8100 },
  ])('accepts $value', ({ value, expected }) => {
    expect(normalizeDesktopPort(value)).toBe(expected);
  });

  it.each([
    { value: undefined, why: 'missing' },
    { value: '', why: 'empty' },
    { value: 70_000, why: 'above the range' },
    { value: 'nope', why: 'not a number' },
    { value: 8123.5, why: 'not an integer' },
    { value: 0, why: 'below the range' },
    { value: 80, why: 'a privileged port' },
    { value: 1023, why: 'just below the range' },
    { value: 65_536, why: 'just above the range' },
    { value: '1e3', why: 'exponent notation' },
    { value: '80abc', why: 'trailing characters' },
    { value: '８０８０', why: 'full width digits' },
    { value: [8080], why: 'not a scalar' },
    { value: true, why: 'a boolean' },
  ])('falls back on $why', ({ value }) => {
    expect(normalizeDesktopPort(value)).toBe(DEFAULT_GATEWAY_PORT);
    expect(normalizeDesktopPort(value, 9000)).toBe(9000);
  });
});

describe('isDesktopMode', () => {
  it.each([
    { env: { CODEBUDDY_DESKTOP: '1' }, expected: true },
    { env: { CODEBUDDY_DESKTOP: ' 1 ' }, expected: true },
    { env: { CODEBUDDY_DESKTOP: '0' }, expected: false },
    { env: { CODEBUDDY_DESKTOP: '' }, expected: false },
    { env: {}, expected: false },
  ])('reads $env', ({ env, expected }) => {
    expect(isDesktopMode(asEnv(env))).toBe(expected);
  });
});

describe('readDesktopSettings', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('falls back to the default when nothing has been saved', () => {
    expect(readDesktopSettings(userDataDir)).toEqual(defaultDesktopSettings());
  });

  it.each([
    { contents: 'not json', why: 'unparseable' },
    { contents: '[]', why: 'not an object' },
    { contents: '{}', why: 'no port' },
    { contents: '{"port": 70000}', why: 'an out-of-range port' },
  ])('falls back to the default on $why', ({ contents }) => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(desktopSettingsPath(userDataDir), contents);

    expect(readDesktopSettings(userDataDir)).toEqual(defaultDesktopSettings());
  });

  it('reads a saved port', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      desktopSettingsPath(userDataDir),
      JSON.stringify({ port: 8123 }),
    );

    expect(readDesktopSettings(userDataDir)).toEqual({
      backend: { mode: 'local' },
      port: 8123,
    });
  });

  it('reads a saved remote backend', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      desktopSettingsPath(userDataDir),
      JSON.stringify({
        backend: { mode: 'remote', url: 'https://api.example.com' },
      }),
    );

    expect(readDesktopSettings(userDataDir)).toEqual({
      backend: { mode: 'remote', url: 'https://api.example.com' },
      port: DEFAULT_GATEWAY_PORT,
    });
  });

  it('ignores a backend it cannot open', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      desktopSettingsPath(userDataDir),
      JSON.stringify({
        backend: { mode: 'remote', url: 'javascript:alert(1)' },
      }),
    );

    expect(readDesktopSettings(userDataDir).backend).toEqual({
      mode: 'local',
    });
  });
});

describe('writeDesktopSettings', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('round-trips through readDesktopSettings', () => {
    expect(writeDesktopSettings(userDataDir, defaultDesktopSettings())).toEqual(
      defaultDesktopSettings(),
    );
    expect(readDesktopSettings(userDataDir)).toEqual(defaultDesktopSettings());
  });

  it('creates the directory it writes into', () => {
    writeDesktopSettings(nestedDir, {
      backend: { mode: 'local' },
      port: 8123,
    });

    expect(readDesktopSettings(nestedDir).port).toBe(8123);
  });

  it('keeps a remote backend it was handed', () => {
    const backend: DesktopBackend = {
      mode: 'remote',
      url: 'https://api.example.com',
    };

    expect(writeDesktopSettings(userDataDir, { backend, port: 8123 })).toEqual({
      backend,
      port: 8123,
    });
    expect(readDesktopSettings(userDataDir).backend).toEqual(backend);
  });

  it('refuses to save an unusable port', () => {
    expect(
      writeDesktopSettings(userDataDir, {
        backend: { mode: 'local' },
        port: 0,
      }),
    ).toEqual(defaultDesktopSettings());
    expect(readDesktopSettings(userDataDir)).toEqual(defaultDesktopSettings());
  });

  it('writes a file only the user can read', () => {
    writeDesktopSettings(userDataDir, defaultDesktopSettings());

    expect(fs.statSync(desktopSettingsPath(userDataDir)).mode & 0o777).toBe(
      0o600,
    );
  });

  it('writes json a human can edit', () => {
    writeDesktopSettings(userDataDir, defaultDesktopSettings());

    expect(fs.readFileSync(desktopSettingsPath(userDataDir), 'utf8')).toBe(
      '{\n  "backend": {\n    "mode": "local"\n  },\n  "port": 8001\n}\n',
    );
  });
});

describe('resolveDesktopPreferredPort', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('prefers the saved port once one exists', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      desktopSettingsPath(userDataDir),
      JSON.stringify({ port: 8123 }),
    );

    expect(
      resolveDesktopPreferredPort(
        userDataDir,
        asEnv({ CODEBUDDY_DESKTOP_PORT: '9000' }),
      ),
    ).toBe(8123);
  });

  it('honours CODEBUDDY_DESKTOP_PORT before anything is saved', () => {
    expect(
      resolveDesktopPreferredPort(
        userDataDir,
        asEnv({ CODEBUDDY_DESKTOP_PORT: '9000' }),
      ),
    ).toBe(9000);
  });

  it('ignores an unusable CODEBUDDY_DESKTOP_PORT', () => {
    expect(
      resolveDesktopPreferredPort(
        userDataDir,
        asEnv({ CODEBUDDY_DESKTOP_PORT: 'loopback' }),
      ),
    ).toBe(DEFAULT_GATEWAY_PORT);
  });

  it('starts on the default port with nothing configured', () => {
    expect(resolveDesktopPreferredPort(userDataDir, asEnv())).toBe(
      DEFAULT_GATEWAY_PORT,
    );
  });
});

describe('isPinnedPort', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('pins a port the environment named', () => {
    expect(
      isPinnedPort(userDataDir, asEnv({ CODEBUDDY_DESKTOP_PORT: '9000' })),
    ).toBe(true);
  });

  it('pins the default when the environment named it', () => {
    expect(
      isPinnedPort(
        userDataDir,
        asEnv({ CODEBUDDY_DESKTOP_PORT: String(DEFAULT_GATEWAY_PORT) }),
      ),
    ).toBe(true);
  });

  it('pins a saved port the console was asked for', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    writeDesktopSettings(userDataDir, {
      ...defaultDesktopSettings(),
      port: 8123,
    });

    expect(isPinnedPort(userDataDir, asEnv())).toBe(true);
  });

  it('leaves the port free to walk upwards with nothing configured', () => {
    expect(isPinnedPort(userDataDir, asEnv())).toBe(false);
  });

  it('ignores an environment value that is not a port', () => {
    expect(
      isPinnedPort(userDataDir, asEnv({ CODEBUDDY_DESKTOP_PORT: 'loopback' })),
    ).toBe(false);
  });

  it('does not pin the default port a backend save wrote along with it', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    writeDesktopSettings(userDataDir, defaultDesktopSettings());

    expect(isPinnedPort(userDataDir, asEnv())).toBe(false);
  });
});
