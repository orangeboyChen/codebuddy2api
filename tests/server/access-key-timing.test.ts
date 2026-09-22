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
