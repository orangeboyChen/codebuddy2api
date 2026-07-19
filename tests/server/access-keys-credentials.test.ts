import fs from 'node:fs';
import path from 'node:path';

import {
  createAccessKey,
  findAccessKeyById,
  findAccessKeyBySecret,
  hasAccessKeys,
  listAccessKeys,
  listStoredAccessKeys,
  removeCredentialReferencesFromAccessKeys,
} from '@/lib/server/domain/access-keys';
import {
  addCredential,
  deleteCredentialByIndex,
  listCredentials,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { writeStorageJson } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-access-keys-credentials');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('access key credential reconciliation', () => {
  beforeEach(async () => {
    cleanupTempState();
    resetCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'default-test-token',
      user_id: 'default@example.com',
    });
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('removes deleted credential references from access keys', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });
    const singleCredential = await addCredential({
      bearer_token: 'token-third',
      user_id: 'third@example.com',
    });

    const multiKey = await createAccessKey({
      credentialFilenames: [
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: 'Multi Key',
    });
    const singleKey = await createAccessKey({
      credentialFilenames: [singleCredential.filename],
      name: 'Single Key',
    });

    const listed = await listCredentials();
    const secondIndex = listed.credentials.findIndex(
      (credential) => credential.filename === secondCredential.filename,
    );
    expect((await deleteCredentialByIndex(secondIndex)).success).toBe(true);
    expect(
      (await findAccessKeyById(multiKey.access_key.id))?.credentialFilenames,
    ).toEqual([firstCredential.filename]);

    const refreshedCredentials = await listCredentials();
    const refreshedSingleIndex = refreshedCredentials.credentials.findIndex(
      (credential) => credential.filename === singleCredential.filename,
    );
    expect((await deleteCredentialByIndex(refreshedSingleIndex)).success).toBe(
      true,
    );
    expect(await findAccessKeyById(singleKey.access_key.id)).toBeNull();
  });

  it('prunes missing credential references while retaining corrupt ones', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDataDir, 'access-keys.json'),
      JSON.stringify({
        accessKeys: [
          {
            id: 'stale-and-valid',
            name: 'Stale and Valid',
            secret: 'cb2_validsecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: ['missing.json', firstCredential.filename],
          },
          {
            id: 'stale-only',
            name: 'Stale Only',
            secret: 'cb2_stalesecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: ['missing.json'],
          },
        ],
      }),
    );

    expect(await listStoredAccessKeys()).toEqual([
      expect.objectContaining({
        credentialFilenames: [firstCredential.filename],
        id: 'stale-and-valid',
      }),
    ]);
    expect(await hasAccessKeys()).toBe(true);
    expect(await findAccessKeyBySecret('cb2_stalesecret')).toBeNull();

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDataDir, 'access-keys.json'), 'utf8'),
    ) as { accessKeys: Array<{ credentialFilenames: string[]; id: string }> };
    expect(persisted.accessKeys).toHaveLength(1);

    const corruptCredential = await addCredential({
      bearer_token: 'token-corrupt',
      user_id: 'corrupt@example.com',
    });
    fs.writeFileSync(
      path.join(tempRootDir, '.codebuddy_creds', corruptCredential.filename),
      '{',
    );
    fs.writeFileSync(
      path.join(tempDataDir, 'access-keys.json'),
      JSON.stringify({
        accessKeys: [
          {
            id: 'corrupt-only',
            name: 'Corrupt Only',
            secret: 'cb2_corruptsecret',
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
            credentialFilenames: [corruptCredential.filename],
          },
        ],
      }),
    );

    expect(await hasAccessKeys()).toBe(true);
    expect(await findAccessKeyBySecret('cb2_corruptsecret')).toMatchObject({
      id: 'corrupt-only',
    });
  });

  it('supports direct credential reference cleanup helper', async () => {
    const firstCredential = await addCredential({
      bearer_token: 'token-first',
      user_id: 'first@example.com',
    });
    const secondCredential = await addCredential({
      bearer_token: 'token-second',
      user_id: 'second@example.com',
    });
    const created = await createAccessKey({
      credentialFilenames: [
        firstCredential.filename,
        secondCredential.filename,
      ],
      name: 'Direct Cleanup Key',
    });

    expect(
      await removeCredentialReferencesFromAccessKeys(secondCredential.filename),
    ).toBe(true);
    expect(
      (await findAccessKeyById(created.access_key.id))?.credentialFilenames,
    ).toEqual([firstCredential.filename]);
    expect(await removeCredentialReferencesFromAccessKeys('missing.json')).toBe(
      false,
    );
  });

  it('keeps concurrent credentials for the same user in separate files', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_783_787_200_000);

    const [first, second] = await Promise.all([
      addCredential({
        bearer_token: 'token-one',
        user_id: 'same@example.com',
      }),
      addCredential({
        bearer_token: 'token-two',
        user_id: 'same@example.com',
      }),
    ]);

    expect(first.filename).not.toBe(second.filename);
    expect(
      (await listCredentials()).credentials.filter(
        (credential) => credential.user_id === 'same@example.com',
      ),
    ).toHaveLength(2);
  });

  it('rejects credential filenames that escape or replace manager state', async () => {
    await expect(
      addCredential(
        { bearer_token: 'token-traversal' },
        '../outside-credentials.json',
      ),
    ).rejects.toThrow('Credential filename must not contain path separators');
    await expect(
      addCredential({ bearer_token: 'token-state' }, 'manager_state.json'),
    ).rejects.toThrow('Credential filename is reserved');
  });

  it('preserves access keys created concurrently', async () => {
    const credential = (await listCredentials()).credentials[0];
    const filename = String(credential?.filename);

    const [first, second] = await Promise.all([
      createAccessKey({
        credentialFilenames: [filename],
        name: 'First Key',
      }),
      createAccessKey({
        credentialFilenames: [filename],
        name: 'Second Key',
      }),
    ]);

    await expect(listStoredAccessKeys()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.access_key.id }),
        expect.objectContaining({ id: second.access_key.id }),
      ]),
    );
  });

  it('masks persisted short access-key secrets safely', async () => {
    const credential = (await listCredentials()).credentials[0];
    const now = '2026-07-19T00:00:00.000Z';

    await writeStorageJson('access-keys', 'store', {
      accessKeys: [
        {
          createdAt: now,
          credentialFilenames: [credential.filename],
          id: 'short-secret',
          name: 'Short secret',
          secret: 'abc',
          updatedAt: now,
        },
      ],
    });

    await expect(listAccessKeys()).resolves.toMatchObject({
      access_keys: [
        {
          id: 'short-secret',
          maskedSecret: '****',
        },
      ],
    });
  });
});
