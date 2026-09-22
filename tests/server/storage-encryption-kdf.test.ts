import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-storage-encryption-kdf');
const databasePath = path.join(tempRootDir, 'storage.sqlite');

const LEGACY_PASSPHRASE = 'legacy-storage-secret';

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const createTempDir = (): void => {
  cleanupTempState();
  fs.mkdirSync(tempRootDir, { recursive: true });
};

/** Mirrors the pre-upgrade derivation: one unsalted SHA-256 pass. */
const legacyKey = (passphrase: string): Buffer => {
  return crypto.createHash('sha256').update(passphrase).digest();
};

const scryptKey = (passphrase: string, salt: Buffer): Buffer => {
  return crypto.scryptSync(passphrase, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
};

const encryptWithKey = (value: unknown, key: Buffer): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64',
  );
};

const decryptWithKey = (ciphertext: string, key: Buffer): unknown => {
  const buffer = Buffer.from(ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    buffer.subarray(0, 12),
  );
  decipher.setAuthTag(buffer.subarray(12, 28));

  return JSON.parse(
    Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString('utf8'),
  ) as unknown;
};

const configureSqliteStorage = (passphrase: string): void => {
  process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
  process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = passphrase;
  process.env.CODEBUDDY_STORAGE_SQLITE_PATH = databasePath;
  process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES = 'false';
};

const openSqliteAdapter = async () => {
  const { DrizzleSqliteDatabaseStorageAdapter } =
    await import('@/lib/server/storage/backends/sqlite');
  const adapter = new DrizzleSqliteDatabaseStorageAdapter({
    path: databasePath,
  });

  await adapter.ensureSchema();

  return adapter;
};

const readSaltRow = async (source: {
  getDocument(
    namespace: string,
    key: string,
  ): Promise<{ payload?: unknown } | null>;
}): Promise<string | null> => {
  const row = await source.getDocument('storage-crypto', 'kdf-salt');
  const payload = row?.payload as { salt?: unknown } | null | undefined;

  return typeof payload?.salt === 'string' ? payload.salt : null;
};

interface MockAdapterHooks {
  getDocument?: (
    namespace: string,
    key: string,
  ) => Promise<Record<string, unknown> | null>;
  putDocument?: (input: Record<string, unknown>) => Promise<void>;
  putDocumentIfAbsent?: (input: Record<string, unknown>) => Promise<void>;
}

const installPgAdapterMock = (
  hooks: MockAdapterHooks,
): {
  getDocument: ReturnType<typeof vi.fn>;
  putDocument: ReturnType<typeof vi.fn>;
  putDocumentIfAbsent: ReturnType<typeof vi.fn>;
} => {
  const getDocument = vi.fn(
    async (
      namespace: string,
      key: string,
    ): Promise<Record<string, unknown> | null> =>
      (await hooks.getDocument?.(namespace, key)) ?? null,
  );
  const putDocument = vi.fn(async (input: Record<string, unknown>) => {
    await hooks.putDocument?.(input);
  });
  const putDocumentIfAbsent = vi.fn(async (input: Record<string, unknown>) => {
    await hooks.putDocumentIfAbsent?.(input);
  });
  const noop = vi.fn(async () => undefined);

  vi.doMock('@/lib/server/storage/backends/postgres', () => ({
    DrizzlePgDatabaseStorageAdapter: class MockAdapter {
      public appendDebugLogs = noop;
      public appendUsageEvents = noop;
      public clearDebugLogs = noop;
      public clearUsageEvents = noop;
      public deleteDocument = noop;
      public ensureSchema = noop;
      public getDocument = getDocument;
      public listDebugLogs = vi.fn(async () => []);
      public listDocuments = vi.fn(async () => []);
      public listUsageEvents = vi.fn(async () => []);
      public putDocument = putDocument;
      public putDocumentIfAbsent = putDocumentIfAbsent;
      public trimDebugLogs = noop;
      public trimUsageEvents = noop;
    },
  }));

  return { getDocument, putDocument, putDocumentIfAbsent };
};

const configurePgStorage = (passphrase: string): void => {
  process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
  process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = passphrase;
  process.env.CODEBUDDY_STORAGE_PG_URL = 'postgres://example.test/codebuddy';
  process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES = 'false';
};

const lastPutFor = (
  putDocument: ReturnType<typeof vi.fn>,
  namespace: string,
): Record<string, unknown> | null => {
  const calls = putDocument.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((input) => input.namespace === namespace);

  return calls[calls.length - 1] ?? null;
};

describe('storage encryption KDF upgrade', () => {
  beforeEach(() => {
    createTempDir();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_STORAGE_SQLITE_PATH;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES;
  });

  afterEach(() => {
    cleanupTempState();
    vi.doUnmock('@/lib/server/storage/backends/postgres');
  });

  it('still decrypts documents written with the legacy sha256 derivation', async () => {
    configureSqliteStorage(LEGACY_PASSPHRASE);

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();

    const legacyValue = { bearer_token: 'legacy-token' };
    const adapter = await openSqliteAdapter();
    await adapter.putDocument({
      encryptedPayload: encryptWithKey(
        legacyValue,
        legacyKey(LEGACY_PASSPHRASE),
      ),
      encryptionMode: 'aes-256-gcm',
      key: 'legacy.json',
      namespace: 'credentials',
      payload: null,
    });

    await expect(
      storage.readStorageJson('credentials', 'legacy.json'),
    ).resolves.toEqual(legacyValue);
    await expect(storage.listStorageJson('credentials')).resolves.toEqual([
      { key: 'legacy.json', value: legacyValue },
    ]);
  });

  it('writes new sensitive documents with the scrypt mode and a persisted salt', async () => {
    configureSqliteStorage(LEGACY_PASSPHRASE);

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();
    await storage.writeStorageJson('credentials', 'fresh.json', {
      bearer_token: 'fresh-token',
    });

    const adapter = await openSqliteAdapter();
    const row = await adapter.getDocument('credentials', 'fresh.json');
    expect(row?.encryptionMode).toBe(storage.STORAGE_ENCRYPTION_MODES.scrypt);
    expect(row?.encryptionMode).toBe('aes-256-gcm:v2');
    expect(row?.payload).toBeNull();

    const salt = await readSaltRow(adapter);
    expect(salt).toEqual(expect.any(String));
    expect(Buffer.from(salt as string, 'base64')).toHaveLength(16);

    await expect(
      storage.readStorageJson('credentials', 'fresh.json'),
    ).resolves.toEqual({ bearer_token: 'fresh-token' });

    // Pre-upgrade rows in the same database stay readable after the upgrade:
    // legacy documents keep the sha256 derivation while new ones use scrypt.
    await adapter.putDocument({
      encryptedPayload: encryptWithKey(
        { bearer_token: 'legacy-token' },
        legacyKey(LEGACY_PASSPHRASE),
      ),
      encryptionMode: 'aes-256-gcm',
      key: 'legacy.json',
      namespace: 'credentials',
      payload: null,
    });
    await expect(
      storage.readStorageJson('credentials', 'legacy.json'),
    ).resolves.toEqual({ bearer_token: 'legacy-token' });
    await expect(storage.listStorageJson('credentials')).resolves.toEqual([
      { key: 'fresh.json', value: { bearer_token: 'fresh-token' } },
      { key: 'legacy.json', value: { bearer_token: 'legacy-token' } },
    ]);

    // The upgraded KDF must not reproduce the legacy key, and the ciphertext
    // must only open with scrypt over the persisted salt.
    const ciphertext = row?.encryptedPayload as string;
    expect(() =>
      decryptWithKey(ciphertext, legacyKey(LEGACY_PASSPHRASE)),
    ).toThrow();
    expect(
      decryptWithKey(
        ciphertext,
        scryptKey(LEGACY_PASSPHRASE, Buffer.from(salt as string, 'base64')),
      ),
    ).toEqual({ bearer_token: 'fresh-token' });
  });

  it('reuses the persisted salt across restarts and keeps documents readable', async () => {
    configureSqliteStorage(LEGACY_PASSPHRASE);

    const firstRuntime = await import('@/lib/server/storage');
    firstRuntime.resetStorageRuntime();
    await firstRuntime.ensureStorageReady();
    await firstRuntime.writeStorageJson('credentials', 'first.json', {
      bearer_token: 'first-token',
    });

    const firstAdapter = await openSqliteAdapter();
    const persistedSalt = await readSaltRow(firstAdapter);

    vi.resetModules();

    const secondRuntime = await import('@/lib/server/storage');
    secondRuntime.resetStorageRuntime();
    await secondRuntime.ensureStorageReady();
    await secondRuntime.writeStorageJson('credentials', 'second.json', {
      bearer_token: 'second-token',
    });

    const secondAdapter = await openSqliteAdapter();
    expect(await readSaltRow(secondAdapter)).toBe(persistedSalt);
    await expect(
      secondRuntime.readStorageJson('credentials', 'first.json'),
    ).resolves.toEqual({ bearer_token: 'first-token' });
    await expect(
      secondRuntime.readStorageJson('credentials', 'second.json'),
    ).resolves.toEqual({ bearer_token: 'second-token' });
  });

  it('stores plain JSON when no encryption key is configured', async () => {
    configureSqliteStorage(LEGACY_PASSPHRASE);

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();

    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    await storage.writeStorageJson('credentials', 'plain.json', {
      bearer_token: 'plain-token',
    });

    const adapter = await openSqliteAdapter();
    const row = await adapter.getDocument('credentials', 'plain.json');
    expect(row?.encryptionMode).toBe('plain-json');
    expect(row?.encryptedPayload).toBe(
      JSON.stringify({ bearer_token: 'plain-token' }),
    );
    await expect(
      storage.readStorageJson('credentials', 'plain.json'),
    ).resolves.toEqual({ bearer_token: 'plain-token' });
  });

  it('fails loudly when an encrypted document is read without the key', async () => {
    configureSqliteStorage(LEGACY_PASSPHRASE);

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();
    await storage.writeStorageJson('credentials', 'fresh.json', {
      bearer_token: 'fresh-token',
    });

    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    await expect(
      storage.readStorageJson('credentials', 'fresh.json'),
    ).rejects.toThrow(
      'Encrypted storage requires CODEBUDDY_STORAGE_ENCRYPTION_KEY',
    );
  });

  it('falls back to the legacy mode when the salt cannot be persisted', async () => {
    configurePgStorage(LEGACY_PASSPHRASE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getDocument, putDocument } = installPgAdapterMock({
      putDocumentIfAbsent: async (input) => {
        if (input.namespace === 'storage-crypto') {
          throw new Error('read-only storage');
        }
      },
    });

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();

    await expect(
      storage.writeStorageJson('credentials', 'cred.json', {
        bearer_token: 'token',
      }),
    ).resolves.toBeUndefined();

    const written = lastPutFor(putDocument, 'credentials');
    expect(written?.encryptionMode).toBe('aes-256-gcm');
    expect(warn).toHaveBeenCalledTimes(1);

    // The legacy ciphertext stays readable through the same backend.
    getDocument.mockResolvedValue({
      encryptedPayload: written?.encryptedPayload ?? null,
      encryptionMode: written?.encryptionMode ?? null,
      key: 'cred.json',
      payload: null,
    });
    await expect(
      storage.readStorageJson('credentials', 'cred.json'),
    ).resolves.toEqual({ bearer_token: 'token' });

    // A second write retries the salt but warns only once.
    await storage.writeStorageJson('credentials', 'cred-2.json', {
      bearer_token: 'token-2',
    });
    expect(lastPutFor(putDocument, 'credentials')?.encryptionMode).toBe(
      'aes-256-gcm',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith('storage-crypto', 'kdf-salt');
  });

  it('falls back to the legacy mode when the salt cannot be read', async () => {
    configurePgStorage(LEGACY_PASSPHRASE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { putDocument } = installPgAdapterMock({
      getDocument: async (namespace) => {
        if (namespace === 'storage-crypto') {
          throw new Error('storage unavailable');
        }

        return null;
      },
    });

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();

    await expect(
      storage.writeStorageJson('responses', 'resp-1', { transcript: [] }),
    ).resolves.toBeUndefined();
    expect(lastPutFor(putDocument, 'responses')?.encryptionMode).toBe(
      'aes-256-gcm',
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads a salt stored as a serialized JSON payload', async () => {
    configurePgStorage(LEGACY_PASSPHRASE);
    const salt = crypto.randomBytes(16).toString('base64');
    const { putDocument, putDocumentIfAbsent } = installPgAdapterMock({
      getDocument: async (namespace) =>
        namespace === 'storage-crypto'
          ? { payload: JSON.stringify({ salt }) }
          : null,
    });

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();
    await storage.writeStorageJson('credentials', 'cred.json', {
      bearer_token: 'token',
    });

    const written = lastPutFor(putDocument, 'credentials');
    expect(written?.encryptionMode).toBe('aes-256-gcm:v2');
    expect(
      decryptWithKey(
        written?.encryptedPayload as string,
        scryptKey(LEGACY_PASSPHRASE, Buffer.from(salt, 'base64')),
      ),
    ).toEqual({ bearer_token: 'token' });
    // An already persisted salt is never rewritten through either path.
    expect(lastPutFor(putDocument, 'storage-crypto')).toBeNull();
    expect(lastPutFor(putDocumentIfAbsent, 'storage-crypto')).toBeNull();
  });

  /**
   * Writes a credential while the salt row holds `storedPayload`, which may be
   * unusable. The adapter behaves like a real table: a persisted row survives,
   * `putDocumentIfAbsent` is a no-op against it, and `putDocument` replaces it.
   */
  const writeWithStoredSaltDocument = async (
    storedPayload: unknown,
  ): Promise<{
    credentialWrite: Record<string, unknown> | null;
    storedSalt: () => unknown;
  }> => {
    configurePgStorage(LEGACY_PASSPHRASE);
    let saltRow: Record<string, unknown> = { payload: storedPayload };
    const { putDocument } = installPgAdapterMock({
      getDocument: async (namespace) =>
        namespace === 'storage-crypto' ? saltRow : null,
      putDocument: async (input) => {
        if (input.namespace === 'storage-crypto') {
          saltRow = { payload: input.payload };
        }
      },
      putDocumentIfAbsent: async (input) => {
        if (input.namespace === 'storage-crypto') {
          saltRow = { payload: input.payload };
        }
      },
    });

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();
    await storage.writeStorageJson('credentials', 'cred.json', {
      bearer_token: 'token',
    });

    return {
      credentialWrite: lastPutFor(putDocument, 'credentials'),
      storedSalt: () =>
        (saltRow.payload as { salt?: unknown } | undefined)?.salt,
    };
  };

  /**
   * A corrupt salt row has to be repaired, not merely complained about: if the
   * unusable value survives, every later write silently falls back to the weak
   * derivation for the lifetime of the deployment.
   */
  const expectSaltRepaired = (
    result: Awaited<ReturnType<typeof writeWithStoredSaltDocument>>,
  ): void => {
    const salt = result.storedSalt();
    expect(salt).toEqual(expect.any(String));
    expect(Buffer.from(salt as string, 'base64')).toHaveLength(16);
    // The effective mode is the real assertion — "we tried to write a salt" is
    // not the same as "the next document is actually protected".
    expect(result.credentialWrite?.encryptionMode).toBe('aes-256-gcm:v2');
    expect(
      decryptWithKey(
        result.credentialWrite?.encryptedPayload as string,
        scryptKey(LEGACY_PASSPHRASE, Buffer.from(salt as string, 'base64')),
      ),
    ).toEqual({ bearer_token: 'token' });
  };

  it('repairs the salt when the stored one has the wrong length', async () => {
    expectSaltRepaired(
      await writeWithStoredSaltDocument({ salt: 'not-a-16-byte-salt' }),
    );
  });

  it('repairs the salt when the stored document is not JSON', async () => {
    expectSaltRepaired(await writeWithStoredSaltDocument('not-json'));
  });

  it('repairs the salt when the stored document has no salt', async () => {
    expectSaltRepaired(await writeWithStoredSaltDocument({}));
  });

  it('repairs a salt that decodes to 16 bytes but is not canonical base64', async () => {
    // `Buffer.from` drops invalid characters, so a corrupted value can still
    // decode to the right length. Accepting it would make the corruption
    // permanent, because an insert-if-absent could never replace it.
    const corrupt = 'AAAAAAAAAAAAAAAAAAAAAA';
    const result = await writeWithStoredSaltDocument({ salt: corrupt });

    // The assertion that actually discriminates: a length-only check would
    // accept the corrupt value as-is and never repair it.
    expect(result.storedSalt()).not.toBe(corrupt);
    expect(
      Buffer.from(result.storedSalt() as string, 'base64').toString('base64'),
    ).toBe(result.storedSalt());
    expectSaltRepaired(result);
  });

  it('falls back to the legacy mode when the salt cannot be repaired', async () => {
    configurePgStorage(LEGACY_PASSPHRASE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { putDocument } = installPgAdapterMock({
      getDocument: async (namespace) =>
        namespace === 'storage-crypto' ? { payload: { salt: 'broken' } } : null,
      putDocument: async (input) => {
        if (input.namespace === 'storage-crypto') {
          throw new Error('read-only storage');
        }
      },
    });

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();
    await storage.ensureStorageReady();
    await storage.writeStorageJson('credentials', 'cred.json', {
      bearer_token: 'token',
    });

    // Unrepairable, so this write degrades rather than failing...
    expect(lastPutFor(putDocument, 'credentials')?.encryptionMode).toBe(
      'aes-256-gcm',
    );
    // ...but it says so, instead of downgrading silently forever.
    expect(warn).toHaveBeenCalled();
  });

  it('throws a descriptive error when a v2 document is read without its salt', async () => {
    configurePgStorage(LEGACY_PASSPHRASE);
    const salt = crypto.randomBytes(16).toString('base64');
    let saltAvailable = true;
    const state: { storedRow: Record<string, unknown> | null } = {
      storedRow: null,
    };
    installPgAdapterMock({
      getDocument: async (namespace) => {
        if (namespace === 'storage-crypto') {
          if (!saltAvailable) {
            throw new Error('storage unavailable');
          }

          return { payload: { salt } };
        }

        return namespace === 'credentials' ? state.storedRow : null;
      },
      putDocument: async (input) => {
        if (input.namespace === 'credentials') {
          state.storedRow = input;
        }
      },
    });

    const firstRuntime = await import('@/lib/server/storage');
    firstRuntime.resetStorageRuntime();
    await firstRuntime.ensureStorageReady();
    await firstRuntime.writeStorageJson('credentials', 'cred.json', {
      bearer_token: 'token',
    });
    expect(state.storedRow?.encryptionMode).toBe('aes-256-gcm:v2');

    // A restart that cannot reach the salt document must fail loudly instead
    // of silently returning unreadable credentials.
    saltAvailable = false;
    vi.resetModules();

    const secondRuntime = await import('@/lib/server/storage');
    secondRuntime.resetStorageRuntime();
    await secondRuntime.ensureStorageReady();
    await expect(
      secondRuntime.readStorageJson('credentials', 'cred.json'),
    ).rejects.toThrow(/storage-crypto\/kdf-salt/);
  });
});
