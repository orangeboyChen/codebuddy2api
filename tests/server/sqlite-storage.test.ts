import fs from 'node:fs';
import path from 'node:path';

const databasePath = path.join(
  process.cwd(),
  '.tmp-test-storage-sqlite',
  'storage.sqlite',
);

const createDatabaseDirectory = (): void => {
  fs.rmSync(path.dirname(databasePath), { force: true, recursive: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
};

describe('drizzle sqlite storage adapter', () => {
  beforeEach(() => {
    createDatabaseDirectory();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(databasePath), { force: true, recursive: true });
  });

  it('persists structured documents, usage events, and debug logs', async () => {
    const { DrizzleSqliteDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/sqlite');
    const adapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: databasePath,
    });

    await adapter.ensureSchema();
    await adapter.putDocument({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'runtime',
      namespace: 'config',
      payload: { enabled: true },
    });
    await adapter.putDocument({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'runtime',
      namespace: 'config',
      payload: { enabled: false },
    });
    expect(await adapter.getDocument('config', 'runtime')).toEqual(
      expect.objectContaining({ payload: { enabled: false } }),
    );

    await adapter.appendUsageEvents([
      {
        id: 'usage-old',
        payload: {
          accessKeyId: null,
          accessKeyName: null,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          callCount: 1,
          credentialFilename: null,
          inputTokens: 1,
          model: 'model',
          outputTokens: 2,
          route: '/v1/messages',
          totalTokens: 3,
        },
        timestamp: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'usage-new',
        payload: {
          accessKeyId: 'key-1',
          accessKeyName: 'main',
          cacheCreationTokens: 1,
          cacheReadTokens: 2,
          callCount: 1,
          credentialFilename: 'credential.json',
          inputTokens: 3,
          model: 'model',
          outputTokens: 4,
          route: '/v1/messages',
          totalTokens: 10,
        },
        timestamp: '2026-07-02T00:00:00.000Z',
      },
    ]);
    expect(
      await adapter.listUsageEvents(new Date('2026-07-01T12:00:00.000Z')),
    ).toEqual([expect.objectContaining({ id: 'usage-new' })]);
    await adapter.trimUsageEvents(new Date('2026-07-02T00:00:00.000Z'));
    expect(await adapter.listUsageEvents(new Date(0))).toHaveLength(1);

    await adapter.appendDebugLogs([
      {
        id: 'debug-1',
        payload: {
          credentialFilename: 'credential.json',
          elapsedMs: 42,
          error: null,
          model: 'gpt-5.5',
          requestBody: { prompt: 'hello' },
          requestKey: 'request-1',
          route: '/v1/messages',
          transformedResponse: null,
          upstreamRequest: null,
          upstreamResponse: { ok: true },
          usage: { inputTokens: 3, outputTokens: 5 },
        },
        timestamp: '2026-07-02T00:00:00.000Z',
      },
    ]);
    expect(await adapter.listDebugLogs(1)).toEqual([
      expect.objectContaining({
        id: 'debug-1',
        payload: expect.objectContaining({
          elapsedMs: 42,
          model: 'gpt-5.5',
          requestBody: { prompt: 'hello' },
          usage: { inputTokens: 3, outputTokens: 5 },
        }),
      }),
    ]);
    await adapter.trimDebugLogs(0);
    expect(await adapter.listDebugLogs(10)).toEqual([]);

    await adapter.deleteDocument('config', 'runtime');
    expect(await adapter.listDocuments('config')).toEqual([]);
  });

  it('applies bundled migrations only once across adapter initializations', async () => {
    const { DrizzleSqliteDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/sqlite');
    const firstAdapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: databasePath,
    });

    await firstAdapter.ensureSchema();
    await firstAdapter.putDocument({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'runtime',
      namespace: 'config',
      payload: { enabled: true },
    });

    const secondAdapter = new DrizzleSqliteDatabaseStorageAdapter({
      path: databasePath,
    });

    await secondAdapter.ensureSchema();
    expect(await secondAdapter.getDocument('config', 'runtime')).toEqual(
      expect.objectContaining({ payload: { enabled: true } }),
    );
  });
});
