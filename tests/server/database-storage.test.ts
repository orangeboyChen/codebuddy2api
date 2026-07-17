const selectLimit = vi.fn<() => Promise<Record<string, unknown>[]>>(
  async () => [],
);
const selectOrderBy = vi.fn<() => Promise<Record<string, unknown>[]>>(
  async () => [],
);
const selectOffset = vi.fn<() => Promise<Record<string, unknown>[]>>(
  async () => [],
);
const insertOnConflictDoUpdate = vi.fn(async () => undefined);
const insertOnConflictDoNothing = vi.fn(async () => undefined);
const deleteWhere = vi.fn(async () => undefined);

const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
}));

const selectFrom = vi.fn(() => ({
  limit: selectLimit,
  orderBy: () => ({ limit: selectLimit, offset: selectOffset }),
  where: selectWhere,
}));

const insertValues = vi.fn(() => ({
  onConflictDoNothing: insertOnConflictDoNothing,
  onConflictDoUpdate: insertOnConflictDoUpdate,
}));

const insert = vi.fn(() => ({
  values: insertValues,
}));

const deleteFrom = vi.fn(() => ({
  where: deleteWhere,
}));

const drizzleMock = vi.fn(() => ({
  delete: deleteFrom,
  insert,
  select: vi.fn(() => ({
    from: selectFrom,
  })),
}));

const poolConstructor = vi.fn();
const poolQuery = vi.fn(async () => undefined);
const poolRelease = vi.fn();
const migrate = vi.fn(async () => undefined);

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: drizzleMock,
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate,
}));

vi.mock('pg', () => ({
  Pool: class MockPool {
    public constructor(options: unknown) {
      poolConstructor(options);
    }

    public async connect() {
      return {
        query: poolQuery,
        release: poolRelease,
      };
    }
  },
}));

describe('drizzle pg storage adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([]);
    selectOrderBy.mockResolvedValue([]);
  });

  it('creates schema and table objects and forwards CRUD operations through drizzle', async () => {
    const { DrizzlePgDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/postgres');

    const adapter = new DrizzlePgDatabaseStorageAdapter({
      connectionString: 'postgres://example.test/codebuddy',
      schemaName: 'codebuddy_test',
    });

    expect(poolConstructor).toHaveBeenCalledWith({
      connectionString: 'postgres://example.test/codebuddy',
    });
    selectLimit.mockResolvedValueOnce([
      {
        encryptedPayload: null,
        encryptionMode: null,
        key: 'runtime',
        payload: '{"enabled":true}',
      },
    ]);
    expect(await adapter.getDocument('config', 'runtime')).toEqual({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'runtime',
      payload: '{"enabled":true}',
    });

    selectOrderBy.mockResolvedValueOnce([
      {
        encryptedPayload: null,
        encryptionMode: null,
        key: 'a.json',
        payload: '{"id":"a"}',
      },
    ]);
    expect(await adapter.listDocuments('credentials')).toEqual([
      {
        encryptedPayload: null,
        encryptionMode: null,
        key: 'a.json',
        payload: '{"id":"a"}',
      },
    ]);

    await adapter.putDocument({
      encryptedPayload: 'cipher',
      encryptionMode: 'aes-256-gcm',
      key: 'cred-a.json',
      namespace: 'credentials',
      payload: null,
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        documentKey: 'cred-a.json',
        encryptedPayload: 'cipher',
        encryptionMode: 'aes-256-gcm',
        namespace: 'credentials',
        payload: null,
      }),
    );
    expect(insertOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          encryptedPayload: 'cipher',
          encryptionMode: 'aes-256-gcm',
          payload: null,
          updatedAt: expect.any(Object),
        }),
        target: expect.any(Array),
      }),
    );

    await adapter.putDocument({
      encryptedPayload: null,
      encryptionMode: null,
      key: 'runtime',
      namespace: 'config',
      payload: { enabled: true },
    });
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: { enabled: true },
      }),
    );

    await adapter.appendUsageEvents([
      {
        id: 'usage-1',
        payload: {
          accessKeyId: null,
          accessKeyName: null,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          callCount: 1,
          credentialFilename: null,
          inputTokens: 0,
          model: 'test',
          outputTokens: 1,
          route: '/v1/chat/completions',
          totalTokens: 1,
        },
        timestamp: '2026-07-12T00:00:00.000Z',
      },
    ]);
    expect(insertOnConflictDoNothing).toHaveBeenCalledTimes(1);

    selectOrderBy.mockResolvedValueOnce([
      {
        accessKeyId: null,
        accessKeyName: null,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        callCount: 1,
        credentialFilename: null,
        eventId: 'usage-1',
        inputTokens: 0,
        model: 'test',
        occurredAt: new Date('2026-07-12T00:00:00.000Z'),
        outputTokens: 1,
        route: '/v1/chat/completions',
        totalTokens: 1,
      },
    ]);
    expect(
      await adapter.listUsageEvents(new Date('2026-07-01T00:00:00.000Z')),
    ).toEqual([expect.objectContaining({ id: 'usage-1' })]);
    await adapter.clearUsageEvents();
    await adapter.trimUsageEvents(new Date('2026-07-01T00:00:00.000Z'));

    await adapter.appendDebugLogs([
      {
        id: 'debug-1',
        payload: {
          credentialFilename: null,
          elapsedMs: 42,
          error: null,
          model: 'gpt-5.5',
          requestBody: null,
          requestKey: null,
          route: '/v1/chat/completions',
          transformedResponse: null,
          upstreamRequest: null,
          upstreamResponse: null,
          usage: { inputTokens: 3, outputTokens: 5 },
        },
        timestamp: '2026-07-12T00:00:00.000Z',
      },
    ]);
    selectLimit.mockResolvedValueOnce([
      {
        createdAt: new Date('2026-07-12T00:00:00.000Z'),
        credentialFilename: null,
        elapsedMs: 42,
        error: null,
        eventId: 'debug-1',
        model: 'gpt-5.5',
        requestBody: null,
        requestKey: null,
        route: '/v1/chat/completions',
        transformedResponse: null,
        upstreamRequest: null,
        upstreamResponse: null,
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    ]);
    expect(await adapter.listDebugLogs(1)).toEqual([
      expect.objectContaining({
        id: 'debug-1',
        payload: expect.objectContaining({
          elapsedMs: 42,
          model: 'gpt-5.5',
          usage: { inputTokens: 3, outputTokens: 5 },
        }),
      }),
    ]);
    await adapter.clearDebugLogs();
    await adapter.trimDebugLogs(100);
    selectOffset.mockResolvedValueOnce([{ eventId: 'debug-1' }]);
    await adapter.trimDebugLogs(0);

    await adapter.ensureSchema();
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(poolQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_lock($1)',
      [1_873_289_124],
    );
    expect(poolQuery).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock($1)',
      [1_873_289_124],
    );
    expect(poolRelease).toHaveBeenCalledTimes(1);
    expect(selectLimit).toHaveBeenCalledTimes(5);

    await adapter.deleteDocument('config', 'runtime');
    expect(deleteFrom).toHaveBeenCalledTimes(5);
    expect(deleteWhere).toHaveBeenCalledTimes(3);
  });

  it('returns null when a document is missing', async () => {
    const { DrizzlePgDatabaseStorageAdapter } =
      await import('@/lib/server/storage/backends/postgres');

    const adapter = new DrizzlePgDatabaseStorageAdapter({
      connectionString: 'postgres://example.test/codebuddy',
      schemaName: 'codebuddy_test',
    });

    expect(await adapter.getDocument('config', 'missing')).toBeNull();
  });
});
