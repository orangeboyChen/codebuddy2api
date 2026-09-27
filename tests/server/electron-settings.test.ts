import fs from 'node:fs';
import path from 'node:path';

import {
  defaultDesktopSettings,
  desktopSettingsPath,
  isDesktopMode,
  normalizeDesktopPort,
  readDesktopSettings,
  resolveDesktopPreferredPort,
  writeDesktopSettings,
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

describe('defaultDesktopSettings', () => {
  it('starts on the documented gateway port', () => {
    expect(defaultDesktopSettings()).toEqual({ port: DEFAULT_GATEWAY_PORT });
  });
});

describe('normalizeDesktopPort', () => {
  it.each([
    { value: '8001', expected: 8001 },
    { value: 8123, expected: 8123 },
    { value: 1, expected: 1 },
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
    { value: 65_536, why: 'just above the range' },
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
    expect(readDesktopSettings(userDataDir)).toEqual({
      port: DEFAULT_GATEWAY_PORT,
    });
  });

  it.each([
    { contents: 'not json', why: 'unparseable' },
    { contents: '[]', why: 'not an object' },
    { contents: '{}', why: 'no port' },
    { contents: '{"port": 70000}', why: 'an out-of-range port' },
  ])('falls back to the default on $why', ({ contents }) => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(desktopSettingsPath(userDataDir), contents);

    expect(readDesktopSettings(userDataDir)).toEqual({
      port: DEFAULT_GATEWAY_PORT,
    });
  });

  it('reads a saved port', () => {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      desktopSettingsPath(userDataDir),
      JSON.stringify({ port: 8123 }),
    );

    expect(readDesktopSettings(userDataDir)).toEqual({ port: 8123 });
  });
});

describe('writeDesktopSettings', () => {
  beforeEach(resetRoot);
  afterEach(resetRoot);

  it('round-trips through readDesktopSettings', () => {
    expect(writeDesktopSettings(userDataDir, { port: 8123 })).toEqual({
      port: 8123,
    });
    expect(readDesktopSettings(userDataDir)).toEqual({ port: 8123 });
  });

  it('creates the directory it writes into', () => {
    writeDesktopSettings(nestedDir, { port: 8123 });

    expect(readDesktopSettings(nestedDir)).toEqual({ port: 8123 });
  });

  it('refuses to save an unusable port', () => {
    expect(writeDesktopSettings(userDataDir, { port: 0 })).toEqual({
      port: DEFAULT_GATEWAY_PORT,
    });
    expect(readDesktopSettings(userDataDir)).toEqual({
      port: DEFAULT_GATEWAY_PORT,
    });
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
