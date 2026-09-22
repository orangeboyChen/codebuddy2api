import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createAccessKey,
  findAccessKeyBySecret,
} from '@/lib/server/domain/access-keys';
import { resetCredentialRuntimeState } from '@/lib/server/domain/credentials';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-access-key-timing');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('access key secret comparison', () => {
  it('compares through the constant-time primitive, not ===', async () => {
    // The point of this suite. Every other assertion below holds for a plain
    // `===` as well, so without this one the file would still go green after
    // the constant-time comparison was reverted.
    const timingSafeEqual = vi.spyOn(crypto, 'timingSafeEqual');

    try {
      const secret = await createKey('timing');

      await expect(findAccessKeyBySecret(secret)).resolves.toMatchObject({
        name: 'timing',
      });

      expect(timingSafeEqual).toHaveBeenCalled();

      // Both operands are fixed-length digests, so the call cannot throw on a
      // length mismatch and cannot leak the length of either secret.
      const [left, right] = timingSafeEqual.mock.calls[0] as unknown as [
        { length: number },
        { length: number },
      ];
      expect(left).toBeInstanceOf(Buffer);
      expect(right).toBeInstanceOf(Buffer);
      expect(left.length).toBe(right.length);
      expect(left.length).toBe(32);

      await expect(
        findAccessKeyBySecret('cb2_not-a-real-secret'),
      ).resolves.toBeNull();
      // A miss is compared the same way; a short-circuiting comparison would
      // have bailed out before reaching the primitive for some of these.
      expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    } finally {
      timingSafeEqual.mockRestore();
    }
  });

  beforeEach(async () => {
    cleanupTempState();
    resetCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
  });

  afterEach(() => {
    cleanupTempState();
  });

  const createKey = async (name: string): Promise<string> => {
    const created = await createAccessKey({
      credentialFilenames: [],
      name,
    });

    return created.secret;
  };

  it('resolves the record for the exact secret', async () => {
    const secret = await createKey('Timing Key');

    await expect(findAccessKeyBySecret(secret)).resolves.toMatchObject({
      name: 'Timing Key',
      secret,
    });
  });

  it('returns null for a wrong secret of the same length', async () => {
    const secret = await createKey('Timing Key');
    const sameLengthWrong = `${secret.slice(0, -1)}x`;

    expect(sameLengthWrong).not.toBe(secret);
    expect(await findAccessKeyBySecret(sameLengthWrong)).toBeNull();
  });

  it('returns null for empty and whitespace-only secrets', async () => {
    await createKey('Timing Key');

    expect(await findAccessKeyBySecret('')).toBeNull();
    expect(await findAccessKeyBySecret('   ')).toBeNull();
    expect(await findAccessKeyBySecret('\t\n')).toBeNull();
  });

  it('does not throw when secret lengths differ wildly', async () => {
    const secret = await createKey('Timing Key');

    await expect(findAccessKeyBySecret('a')).resolves.toBeNull();
    await expect(findAccessKeyBySecret(secret.slice(0, 4))).resolves.toBeNull();
    await expect(
      findAccessKeyBySecret(`${secret}${secret.repeat(512)}`),
    ).resolves.toBeNull();
    await expect(findAccessKeyBySecret('x'.repeat(65_536))).resolves.toBeNull();
  });

  it('compares every stored key and only matches one', async () => {
    const firstSecret = await createKey('First Timing Key');
    await createKey('Second Timing Key');

    await expect(findAccessKeyBySecret(firstSecret)).resolves.toMatchObject({
      name: 'First Timing Key',
    });
  });
});
