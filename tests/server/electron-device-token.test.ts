import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_DEVICE_TOKEN_ENV,
  DESKTOP_DEVICE_TOKEN_FILENAME,
  desktopDeviceTokenPath,
  deviceToken,
  forgetDeviceToken,
  readDeviceToken,
  writeDeviceToken,
} from '@/lib/server/electron/device-token';

/**
 * The token on disk, which is what a sign-in leaves behind.
 *
 * It is kept *for* an address: a token is a promise one deployment made to this
 * app, and carrying it to another would be presenting someone else's
 * introduction — so what is covered here is mostly that a token read for one
 * deployment is no token at all for another.
 */

const URL = 'https://admin.example.com';
let dir = '';

describe('the token a deployment handed this app', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-token-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('sits beside the settings, under a name of its own', () => {
    expect(desktopDeviceTokenPath(dir)).toBe(
      path.join(dir, DESKTOP_DEVICE_TOKEN_FILENAME),
    );
  });

  it('is nothing at all before anybody has approved anything', () => {
    expect(readDeviceToken(dir, URL)).toBeNull();
  });

  it('is read back for the deployment it was saved for', () => {
    writeDeviceToken(dir, { token: 'token', url: URL });

    expect(readDeviceToken(dir, URL)).toBe('token');
    // The same address written with a slash behind it is the same address.
    expect(readDeviceToken(dir, `${URL}/`)).toBe('token');
    expect(readDeviceToken(dir, `${URL}///`)).toBe('token');
  });

  it('is no token for another deployment', () => {
    writeDeviceToken(dir, { token: 'token', url: URL });

    expect(readDeviceToken(dir, 'https://elsewhere.example.com')).toBeNull();
  });

  it('is kept where nobody else can read it', () => {
    writeDeviceToken(dir, { token: 'token', url: URL });

    // Readable and writable by the user this app runs as, and by nobody else.
    expect(fs.statSync(desktopDeviceTokenPath(dir)).mode & 0o777).toBe(0o600);
  });

  it('is written even when the directory is not there yet', () => {
    const nested = path.join(dir, 'nested');

    writeDeviceToken(nested, { token: 'token', url: URL });

    expect(readDeviceToken(nested, URL)).toBe('token');
  });

  it.each([
    { name: 'a file that is not JSON', text: 'not json' },
    { name: 'a token that is not a string', text: '{"token":7,"url":"x"}' },
    { name: 'an address that is not a string', text: '{"token":"t","url":7}' },
    { name: 'an empty token', text: `{"token":"  ","url":"${URL}"}` },
  ])('is nothing at all from $name', ({ text }) => {
    fs.writeFileSync(desktopDeviceTokenPath(dir), text);

    expect(readDeviceToken(dir, URL)).toBeNull();
  });

  it('is forgotten when the user signs out', () => {
    writeDeviceToken(dir, { token: 'token', url: URL });

    forgetDeviceToken(dir);

    expect(readDeviceToken(dir, URL)).toBeNull();
    // Nothing to forget is not a failure either.
    expect(() => forgetDeviceToken(dir)).not.toThrow();
  });
});

describe('how the token reaches the gateway', () => {
  it('is the environment, and nothing when the environment has nothing', () => {
    expect(deviceToken({ [DESKTOP_DEVICE_TOKEN_ENV]: ' token ' })).toBe(
      'token',
    );
    expect(deviceToken({ [DESKTOP_DEVICE_TOKEN_ENV]: '   ' })).toBeNull();
    expect(deviceToken({})).toBeNull();
  });
});
