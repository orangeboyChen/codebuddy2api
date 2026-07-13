import { getTableConfig as getPostgresTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';

import { createPostgresStorageSchema } from '@/lib/server/storage/backends/postgres-schema';
import {
  debugLogs as sqliteDebugLogs,
  documents as sqliteDocuments,
  usageEvents as sqliteUsageEvents,
} from '@/lib/server/storage/backends/sqlite-schema';

describe('storage schemas', () => {
  it('defines PostgreSQL documents and indexed event tables', () => {
    const schema = createPostgresStorageSchema('storage_test');

    expect(getPostgresTableConfig(schema.documents).primaryKeys).toHaveLength(
      1,
    );
    expect(getPostgresTableConfig(schema.usageEvents).indexes).toHaveLength(3);
    expect(getPostgresTableConfig(schema.debugLogs).indexes).toHaveLength(1);
  });

  it('defines SQLite documents and indexed event tables', () => {
    expect(getSqliteTableConfig(sqliteDocuments).primaryKeys).toHaveLength(1);
    expect(getSqliteTableConfig(sqliteUsageEvents).indexes).toHaveLength(3);
    expect(getSqliteTableConfig(sqliteDebugLogs).indexes).toHaveLength(1);
  });
});
