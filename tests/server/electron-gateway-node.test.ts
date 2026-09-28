import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GATEWAY_NODE,
  resolveGatewayNodePath,
} from '@/lib/server/electron/gateway-node';

const EXECUTABLE =
  '/Applications/CodeBuddy2API.app/Contents/MacOS/CodeBuddy2API';
const DIRECTORY = '/var/folders/tmp/CodeBuddy2API';
const LINK = path.join(DIRECTORY, GATEWAY_NODE);

/** A filesystem of links, standing in for the real one. */
const links = (): {
  map: Map<string, string>;
  options: Record<string, unknown>;
} => {
  const map = new Map<string, string>();

  return {
    map,
    options: {
      readlink: (target: string) => {
        const value = map.get(target);

        if (value === undefined) {
          throw new Error(`not a link: ${target}`);
        }

        return value;
      },
      remove: (target: string) => {
        map.delete(target);
      },
      symlink: (executable: string, target: string) => {
        map.set(target, executable);
      },
    },
  };
};

const realDirectory = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-node-'));

describe('resolveGatewayNodePath', () => {
  it('links the binary out of its bundle on macOS', () => {
    const { map, options } = links();

    const resolved = resolveGatewayNodePath({
      directory: DIRECTORY,
      executable: EXECUTABLE,
      platform: 'darwin',
      ...options,
    });

    expect(resolved).toBe(LINK);
    expect(map.get(LINK)).toBe(EXECUTABLE);
  });

  it('runs the binary as it is on the other desktops', () => {
    expect(
      resolveGatewayNodePath({
        directory: DIRECTORY,
        executable: EXECUTABLE,
        platform: 'win32',
      }),
    ).toBe(EXECUTABLE);

    expect(
      resolveGatewayNodePath({
        directory: DIRECTORY,
        executable: EXECUTABLE,
        platform: 'linux',
      }),
    ).toBe(EXECUTABLE);
  });

  it('reuses a link that already leads to the same binary', () => {
    const { map, options } = links();

    map.set(LINK, EXECUTABLE);

    const symlink = vi.fn();

    expect(
      resolveGatewayNodePath({
        directory: DIRECTORY,
        executable: EXECUTABLE,
        platform: 'darwin',
        ...options,
        symlink,
      }),
    ).toBe(LINK);
    expect(symlink).not.toHaveBeenCalled();
  });

  it('replaces a link that leads anywhere else', () => {
    const { map, options } = links();

    map.set(
      LINK,
      '/Applications/CodeBuddy2API-2.app/Contents/MacOS/CodeBuddy2API',
    );

    resolveGatewayNodePath({
      directory: DIRECTORY,
      executable: EXECUTABLE,
      platform: 'darwin',
      ...options,
    });

    expect(map.get(LINK)).toBe(EXECUTABLE);
  });

  it('replaces whatever is there when it is not a link at all', () => {
    const { map, options } = links();
    const remove = vi.fn((target: string) => {
      map.delete(target);
    });

    resolveGatewayNodePath({
      directory: DIRECTORY,
      executable: EXECUTABLE,
      platform: 'darwin',
      ...options,
      remove,
    });

    expect(remove).toHaveBeenCalledWith(LINK);
    expect(map.get(LINK)).toBe(EXECUTABLE);
  });

  it('writes the link on a real filesystem, and reuses it', () => {
    const directory = realDirectory();

    try {
      const first = resolveGatewayNodePath({
        directory,
        executable: EXECUTABLE,
        platform: 'darwin',
      });

      expect(first).toBe(path.join(directory, GATEWAY_NODE));
      expect(fs.readlinkSync(first)).toBe(EXECUTABLE);

      // The second call is the one every launch after the first makes.
      expect(
        resolveGatewayNodePath({
          directory,
          executable: EXECUTABLE,
          platform: 'darwin',
        }),
      ).toBe(first);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('replaces a real link that leads to another binary', () => {
    const directory = realDirectory();

    try {
      // What is left behind when the app was installed somewhere else before:
      // the link has to end up leading to the binary this app is running.
      fs.symlinkSync(
        '/Applications/CodeBuddy2API-2.app/Contents/MacOS/CodeBuddy2API',
        path.join(directory, GATEWAY_NODE),
      );

      const resolved = resolveGatewayNodePath({
        directory,
        executable: EXECUTABLE,
        platform: 'darwin',
      });

      expect(resolved).toBe(path.join(directory, GATEWAY_NODE));
      expect(fs.readlinkSync(resolved)).toBe(EXECUTABLE);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('reads the platform off the process when it is given none', () => {
    const directory = realDirectory();
    const platform = process.platform;

    Object.defineProperty(process, 'platform', { value: 'darwin' });

    try {
      const resolved = resolveGatewayNodePath({
        directory,
        executable: EXECUTABLE,
      });

      // Nothing said macOS, so only the platform it is running on can have: had
      // it not been read, the binary would have come back untouched.
      expect(resolved).toBe(path.join(directory, GATEWAY_NODE));
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('leaves a file that is not a link alone, and runs the binary as it is', () => {
    const directory = realDirectory();

    try {
      // Something else's, in a temporary directory this app shares.
      fs.writeFileSync(path.join(directory, GATEWAY_NODE), 'not ours');

      expect(
        resolveGatewayNodePath({
          directory,
          executable: EXECUTABLE,
          platform: 'darwin',
        }),
      ).toBe(EXECUTABLE);
      expect(fs.readFileSync(path.join(directory, GATEWAY_NODE), 'utf8')).toBe(
        'not ours',
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('runs the binary as it is when the link cannot be made', () => {
    expect(
      resolveGatewayNodePath({
        directory: DIRECTORY,
        executable: EXECUTABLE,
        platform: 'darwin',
        remove: () => {
          throw new Error('read-only');
        },
      }),
    ).toBe(EXECUTABLE);
  });

  it('runs the binary as it is when the link does not lead back to it', () => {
    expect(
      resolveGatewayNodePath({
        directory: DIRECTORY,
        executable: EXECUTABLE,
        platform: 'darwin',
        // A filesystem that writes the link and reads something else back.
        readlink: () => 'somewhere else',
        remove: () => undefined,
        symlink: () => undefined,
      }),
    ).toBe(EXECUTABLE);
  });
});
