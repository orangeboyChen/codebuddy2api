const execute = vi.fn(async () => undefined);
const selectLimit = vi.fn<() => Promise<Record<string, unknown>[]>>(
  async () => [],
);
const selectOrderBy = vi.fn<() => Promise<Record<string, unknown>[]>>(
  async () => [],
);
const insertOnConflictDoUpdate = vi.fn(async () => undefined);
const deleteWhere = vi.fn(async () => undefined);

const selectWhere = vi.fn(() => ({
  limit: selectLimit,
  orderBy: selectOrderBy,
}));

const selectFrom = vi.fn(() => ({
  where: selectWhere,
}));

const insertValues = vi.fn(() => ({
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
  execute,
  insert,
  select: vi.fn(() => ({
    from: selectFrom,
  })),
}));

const poolConstructor = vi.fn();

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: drizzleMock,
}));

vi.mock('pg', () => ({
  Pool: class MockPool {
    public constructor(options: unknown) {
      poolConstructor(options);
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
      await import('@/lib/server/storage/database');

    const adapter = new DrizzlePgDatabaseStorageAdapter({
      connectionString: 'postgres://example.test/codebuddy',
      schemaName: 'codebuddy_test',
    });

    await adapter.ensureSchema();

    expect(poolConstructor).toHaveBeenCalledWith({
      connectionString: 'postgres://example.test/codebuddy',
    });
    expect(execute).toHaveBeenCalledTimes(3);

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
        payload: JSON.stringify({ enabled: true }),
      }),
    );

    await adapter.deleteDocument('config', 'runtime');
    expect(deleteFrom).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('returns null when a document is missing', async () => {
    const { DrizzlePgDatabaseStorageAdapter } =
      await import('@/lib/server/storage/database');

    const adapter = new DrizzlePgDatabaseStorageAdapter({
      connectionString: 'postgres://example.test/codebuddy',
      schemaName: 'codebuddy_test',
    });

    expect(await adapter.getDocument('config', 'missing')).toBeNull();
  });
});
