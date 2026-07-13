import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-storage-backends');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');
const tempCredsDir = path.join(tempRootDir, '.codebuddy_creds');
const tempLegacyConfigDir = path.join(tempRootDir, 'config');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('storage backends', () => {
  beforeEach(() => {
    cleanupTempState();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_PERSISTENCE;
    delete process.env.CODEBUDDY_STORAGE_PG_URL;
    delete process.env.DATABASE_URL;
    delete process.env.CODEBUDDY_STORAGE_SQLITE_PATH;
    delete process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('selects file backend by default and pg when configured', async () => {
    const storage = await import('@/lib/server/storage');

    expect(storage.getStorageBackendMeta()).toEqual({
      backend: 'file',
      encryptionEnabled: false,
      schema: null,
    });

    process.env.CODEBUDDY_STORAGE_PERSISTENCE = 'pg';
    storage.resetStorageRuntime();
    expect(storage.getStorageBackendMeta()).toEqual({
      backend: 'pg',
      encryptionEnabled: false,
      schema: 'codebuddy2api',
    });

    process.env.CODEBUDDY_STORAGE_PERSISTENCE = 'file';
    process.env.DATABASE_URL = 'postgres://example.test/codebuddy';
    storage.resetStorageRuntime();
    expect(storage.getStorageBackendMeta()).toEqual({
      backend: 'file',
      encryptionEnabled: false,
      schema: null,
    });

    process.env.CODEBUDDY_STORAGE_PERSISTENCE = '';
    storage.resetStorageRuntime();
    expect(storage.getStorageBackendMeta()).toEqual({
      backend: 'pg',
      encryptionEnabled: false,
      schema: 'codebuddy2api',
    });

    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    storage.resetStorageRuntime();
    expect(storage.getStorageBackendMeta()).toEqual({
      backend: 'sqlite',
      encryptionEnabled: false,
      schema: null,
    });
  });

  it('requires an encryption key before initializing PostgreSQL storage', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
    process.env.CODEBUDDY_STORAGE_PG_URL = 'postgres://example.test/codebuddy';

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();

    await expect(storage.ensureStorageReady()).rejects.toThrow(
      'CODEBUDDY_STORAGE_ENCRYPTION_KEY is required when storage backend is pg',
    );
    storage.resetStorageRuntime();
  });

  it('initializes SQLite storage and forwards event operations', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'storage-secret';
    process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES = 'false';
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = path.join(
      tempRootDir,
      'storage.sqlite',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();

    await storage.ensureStorageReady();
    await storage.writeStorageJson('config', 'runtime', { enabled: true });
    expect(await storage.readStorageJson('config', 'runtime')).toEqual({
      enabled: true,
    });

    const event = {
      id: 'event-1',
      payload: {
        accessKeyId: null,
        accessKeyName: null,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        callCount: 1,
        credentialFilename: null,
        inputTokens: 1,
        model: 'test',
        outputTokens: 1,
        route: '/v1/messages',
        totalTokens: 2,
      },
      timestamp: '2026-07-13T00:00:00.000Z',
    };

    await storage.appendStorageUsageEvents([event]);
    expect(
      await storage.listStorageUsageEvents(
        new Date('2026-07-12T00:00:00.000Z'),
      ),
    ).toHaveLength(1);
    await storage.trimStorageUsageEvents(new Date('2026-07-14T00:00:00.000Z'));
    expect(await storage.listStorageUsageEvents(new Date(0))).toEqual([]);
    await storage.appendStorageDebugLogs([event]);
    expect(await storage.listStorageDebugLogs(10)).toHaveLength(1);
    await storage.clearStorageDebugLogs();
    await storage.clearStorageUsageEvents();
    storage.resetStorageRuntime();
  });

  it('rejects a credential path that is not a directory', async () => {
    fs.mkdirSync(tempRootDir, { recursive: true });
    fs.writeFileSync(tempCredsDir, '{}');

    const storage = await import('@/lib/server/storage');

    await expect(storage.ensureStorageReady()).rejects.toThrow(
      `${tempCredsDir} must be a directory`,
    );
  });

  it('migrates legacy config documents into the default file storage directory', async () => {
    const legacyConfigDir = path.join(tempRootDir, 'config');
    const legacyRuntimeConfig = { CODEBUDDY_AUTH_MODE: 'token' };
    const accessKeyStore = {
      accessKeys: [{ id: 'access-key-1', secret: 'secret' }],
    };

    fs.mkdirSync(legacyConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyConfigDir, 'config.json'),
      JSON.stringify(legacyRuntimeConfig),
    );
    fs.writeFileSync(
      path.join(legacyConfigDir, 'access-keys.json'),
      JSON.stringify(accessKeyStore),
    );

    const storage = await import('@/lib/server/storage');

    await expect(
      storage.readStorageJson('access-keys', 'store'),
    ).resolves.toEqual(accessKeyStore);
    await expect(storage.readStorageJson('config', 'runtime')).resolves.toEqual(
      legacyRuntimeConfig,
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tempDataDir, 'access-keys.json'), 'utf8'),
      ),
    ).toEqual(accessKeyStore);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tempDataDir, 'runtime.json'), 'utf8'),
      ),
    ).toEqual(legacyRuntimeConfig);
  });

  it('imports legacy files into the database backend and encrypts sensitive documents', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
    process.env.CODEBUDDY_STORAGE_PG_URL = 'postgres://example.test/codebuddy';
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'storage-secret';

    fs.mkdirSync(tempLegacyConfigDir, { recursive: true });
    fs.mkdirSync(path.join(tempLegacyConfigDir, 'usage'), {
      recursive: true,
    });
    fs.mkdirSync(tempCredsDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempLegacyConfigDir, 'config.json'),
      JSON.stringify({ CODEBUDDY_AUTH_MODE: 'token' }),
    );
    fs.writeFileSync(
      path.join(tempLegacyConfigDir, 'access-keys.json'),
      JSON.stringify({ keys: [{ id: 'access-key-1' }] }),
    );
    fs.writeFileSync(
      path.join(tempLegacyConfigDir, 'debug-config.json'),
      JSON.stringify({ enabled: true }),
    );
    fs.writeFileSync(
      path.join(tempLegacyConfigDir, 'debug-logs.json'),
      JSON.stringify([{ level: 'error' }]),
    );
    fs.writeFileSync(
      path.join(tempLegacyConfigDir, 'usage/history.json'),
      JSON.stringify([{ id: 'usage-1' }]),
    );
    fs.writeFileSync(
      path.join(tempCredsDir, 'manager_state.json'),
      JSON.stringify({ selectedCredentialFilename: 'cred-a.json' }),
    );
    fs.writeFileSync(
      path.join(tempCredsDir, 'cred-a.json'),
      JSON.stringify({ bearer_token: 'token-a' }),
    );

    const ensureSchema = vi.fn(async () => undefined);
    const getDocument = vi.fn(
      async (): Promise<Record<string, unknown> | null> => null,
    );
    const listDocuments = vi.fn(async (namespace: string) => {
      if (namespace === 'credentials') {
        return [
          {
            encryptedPayload: 'broken',
            encryptionMode: 'unknown',
            key: 'cred-a.json',
            payload: null,
          },
        ];
      }

      if (namespace === 'config') {
        return [
          {
            encryptedPayload: null,
            encryptionMode: null,
            key: 'runtime',
            payload: JSON.stringify({ CODEBUDDY_AUTH_MODE: 'token' }),
          },
        ];
      }

      return [];
    });
    const putDocument = vi.fn(async (_input: unknown) => undefined);
    const deleteDocument = vi.fn(async () => undefined);
    const appendUsageEvents = vi.fn(async () => undefined);
    const listUsageEvents = vi.fn(async () => []);
    const clearUsageEvents = vi.fn(async () => undefined);
    const trimUsageEvents = vi.fn(async () => undefined);
    const appendDebugLogs = vi.fn(async () => undefined);
    const listDebugLogs = vi.fn(async () => []);
    const clearDebugLogs = vi.fn(async () => undefined);
    const trimDebugLogs = vi.fn(async () => undefined);

    vi.doMock('@/lib/server/storage/backends/postgres', () => ({
      DrizzlePgDatabaseStorageAdapter: class MockAdapter {
        public appendDebugLogs = appendDebugLogs;
        public appendUsageEvents = appendUsageEvents;
        public clearDebugLogs = clearDebugLogs;
        public clearUsageEvents = clearUsageEvents;
        public deleteDocument = deleteDocument;
        public ensureSchema = ensureSchema;
        public getDocument = getDocument;
        public listDebugLogs = listDebugLogs;
        public listDocuments = listDocuments;
        public listUsageEvents = listUsageEvents;
        public putDocument = putDocument;
        public trimDebugLogs = trimDebugLogs;
        public trimUsageEvents = trimUsageEvents;
      },
    }));

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();

    await storage.ensureStorageReady();

    expect(ensureSchema).toHaveBeenCalledTimes(1);
    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPayload: null,
        encryptionMode: null,
        key: 'runtime',
        namespace: 'config',
        payload: { CODEBUDDY_AUTH_MODE: 'token' },
      }),
    );
    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPayload: expect.any(String),
        encryptionMode: 'aes-256-gcm',
        key: 'store',
        namespace: 'access-keys',
        payload: null,
      }),
    );
    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPayload: expect.any(String),
        encryptionMode: 'aes-256-gcm',
        key: 'cred-a.json',
        namespace: 'credentials',
        payload: null,
      }),
    );

    await storage.writeStorageJson('credentials', 'cred-b.json', {
      bearer_token: 'token-b',
    });
    await storage.writeStorageJson('config', 'runtime', {
      CODEBUDDY_AUTH_MODE: 'auto',
    });

    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPayload: expect.any(String),
        encryptionMode: 'aes-256-gcm',
        key: 'cred-b.json',
        namespace: 'credentials',
        payload: null,
      }),
    );
    expect(putDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPayload: null,
        encryptionMode: null,
        key: 'runtime',
        namespace: 'config',
        payload: { CODEBUDDY_AUTH_MODE: 'auto' },
      }),
    );

    getDocument.mockResolvedValueOnce({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'serialized',
      payload: '{"enabled":true}',
    });
    expect(await storage.readStorageJson('config', 'serialized')).toEqual({
      enabled: true,
    });

    const encryptedCredential = putDocument.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((input) => {
        return input.key === 'cred-b.json';
      });
    getDocument.mockResolvedValueOnce({
      encryptedPayload: encryptedCredential?.encryptedPayload ?? null,
      encryptionMode: encryptedCredential?.encryptionMode ?? null,
      key: 'cred-b.json',
      payload: null,
    });
    expect(await storage.readStorageJson('credentials', 'cred-b.json')).toEqual(
      {
        bearer_token: 'token-b',
      },
    );

    getDocument.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await storage.readStorageJsonResult('config', 'runtime')).toEqual({
      error: 'database unavailable',
      exists: true,
      value: null,
    });

    await expect(storage.listStorageJson('credentials')).rejects.toThrow(
      'Invalid authentication tag length',
    );

    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'storage-secret';
    expect(await storage.listStorageJson('config')).toEqual([
      {
        key: 'runtime',
        value: {
          CODEBUDDY_AUTH_MODE: 'token',
        },
      },
    ]);

    expect(await storage.readStorageJsonResult('usage', 'history')).toEqual({
      error: null,
      exists: false,
      value: null,
    });

    await storage.deleteStorageJson('credentials', 'cred-a.json');
    expect(deleteDocument).toHaveBeenCalledWith('credentials', 'cred-a.json');

    const event = {
      id: 'event-1',
      payload: { route: '/v1/messages' },
      timestamp: '2026-07-13T00:00:00.000Z',
    };
    const before = new Date('2026-07-12T00:00:00.000Z');

    await storage.appendStorageUsageEvents([event]);
    await storage.listStorageUsageEvents(before);
    await storage.clearStorageUsageEvents();
    await storage.trimStorageUsageEvents(before);
    await storage.appendStorageDebugLogs([event]);
    await storage.listStorageDebugLogs(10);
    await storage.clearStorageDebugLogs();
    await storage.trimStorageDebugLogs(10);

    expect(appendUsageEvents).toHaveBeenCalledWith([event]);
    expect(listUsageEvents).toHaveBeenCalledWith(before);
    expect(clearUsageEvents).toHaveBeenCalledTimes(1);
    expect(trimUsageEvents).toHaveBeenCalledWith(before);
    expect(appendDebugLogs).toHaveBeenCalledWith([event]);
    expect(listDebugLogs).toHaveBeenCalledWith(10);
    expect(clearDebugLogs).toHaveBeenCalledTimes(1);
    expect(trimDebugLogs).toHaveBeenCalledWith(10);
  });

  it('fails fast when pg backend is enabled without a connection string', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'pg';
    process.env.CODEBUDDY_STORAGE_PG_URL = '';
    process.env.DATABASE_URL = '';

    const storage = await import('@/lib/server/storage');
    storage.resetStorageRuntime();

    await expect(storage.ensureStorageReady()).rejects.toThrow(
      'CODEBUDDY_STORAGE_PG_URL or DATABASE_URL is required when storage backend is pg',
    );
  });
});
