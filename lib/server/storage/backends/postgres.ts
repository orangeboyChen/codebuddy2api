import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'node:path';

import { createPostgresStorageSchema } from './postgres-schema';
import type {
  DatabaseStorageAdapter,
  DatabaseDocumentRecord,
  StorageEvent,
} from './types';

export type { DatabaseStorageAdapter, DatabaseDocumentRecord, StorageEvent };

const MIGRATION_LOCK_ID = 1_873_289_124;

interface PgDatabaseStorageAdapterOptions {
  connectionString: string;
  schemaName: string;
}

export class DrizzlePgDatabaseStorageAdapter implements DatabaseStorageAdapter {
  private readonly db: ReturnType<typeof drizzle>;

  private readonly documents: ReturnType<
    typeof createPostgresStorageSchema
  >['documents'];

  private readonly debugLogs: ReturnType<
    typeof createPostgresStorageSchema
  >['debugLogs'];

  private readonly pool: InstanceType<typeof Pool>;

  private readonly usageEvents: ReturnType<
    typeof createPostgresStorageSchema
  >['usageEvents'];

  public constructor(options: PgDatabaseStorageAdapterOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
    });
    this.db = drizzle(this.pool);
    const schema = createPostgresStorageSchema(options.schemaName);
    this.documents = schema.documents;
    this.debugLogs = schema.debugLogs;
    this.usageEvents = schema.usageEvents;
  }

  public async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    let migrationLockAcquired = false;

    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      migrationLockAcquired = true;
      await migrate(this.db, {
        migrationsFolder: path.resolve(
          'lib/server/storage/migrations/postgres',
        ),
      });
    } finally {
      if (migrationLockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_LOCK_ID,
        ]);
      }
      client.release();
    }

    await Promise.all([
      this.db
        .select({ key: this.documents.documentKey })
        .from(this.documents)
        .limit(1),
      this.db
        .select({ key: this.usageEvents.eventId })
        .from(this.usageEvents)
        .limit(1),
      this.db
        .select({ key: this.debugLogs.eventId })
        .from(this.debugLogs)
        .limit(1),
    ]);
  }

  public async appendUsageEvents(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;
    await this.db
      .insert(this.usageEvents)
      .values(
        entries.map((entry) => ({
          ...(entry.payload as {
            accessKeyId: string | null;
            accessKeyName: string | null;
            cacheCreationTokens: number;
            cacheReadTokens: number;
            callCount: number;
            credentialFilename: string | null;
            inputTokens: number;
            model: string;
            outputTokens: number;
            route: string;
            totalTokens: number;
          }),
          eventId: entry.id,
          occurredAt: new Date(entry.timestamp),
        })),
      )
      .onConflictDoNothing();
  }

  public async listUsageEvents(since: Date): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(this.usageEvents)
      .where(gte(this.usageEvents.occurredAt, since))
      .orderBy(asc(this.usageEvents.occurredAt), asc(this.usageEvents.eventId));
    return rows.map((row) => ({
      id: row.eventId,
      payload: {
        accessKeyId: row.accessKeyId,
        accessKeyName: row.accessKeyName,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
        callCount: row.callCount,
        credentialFilename: row.credentialFilename,
        inputTokens: row.inputTokens,
        model: row.model,
        outputTokens: row.outputTokens,
        route: row.route,
        timestamp: row.occurredAt.toISOString(),
        totalTokens: row.totalTokens,
      },
      timestamp: row.occurredAt.toISOString(),
    }));
  }

  public async clearUsageEvents(): Promise<void> {
    await this.db.delete(this.usageEvents);
  }

  public async trimUsageEvents(before: Date): Promise<void> {
    await this.db
      .delete(this.usageEvents)
      .where(lt(this.usageEvents.occurredAt, before));
  }

  public async appendDebugLogs(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;
    await this.db
      .insert(this.debugLogs)
      .values(
        entries.map((entry) => ({
          ...(entry.payload as {
            credentialFilename: string | null;
            elapsedMs: number;
            error: string | null;
            model: string | null;
            requestBody: unknown;
            requestKey: string | null;
            route: string;
            transformedResponse: unknown;
            upstreamRequest: unknown;
            upstreamResponse: unknown;
            usage: unknown;
          }),
          eventId: entry.id,
          createdAt: new Date(entry.timestamp),
        })),
      )
      .onConflictDoNothing();
  }

  public async listDebugLogs(limit: number): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(this.debugLogs)
      .orderBy(desc(this.debugLogs.createdAt), desc(this.debugLogs.eventId))
      .limit(limit);
    return rows.map((row) => ({
      id: row.eventId,
      payload: {
        credentialFilename: row.credentialFilename,
        createdAt: row.createdAt.toISOString(),
        elapsedMs: row.elapsedMs,
        error: row.error,
        id: row.eventId,
        model: row.model,
        requestBody: row.requestBody,
        requestKey: row.requestKey,
        route: row.route,
        transformedResponse: row.transformedResponse,
        upstreamRequest: row.upstreamRequest,
        upstreamResponse: row.upstreamResponse,
        usage: row.usage,
      },
      timestamp: row.createdAt.toISOString(),
    }));
  }

  public async clearDebugLogs(): Promise<void> {
    await this.db.delete(this.debugLogs);
  }

  public async trimDebugLogs(maxEntries: number): Promise<void> {
    const rows = await this.db
      .select({ eventId: this.debugLogs.eventId })
      .from(this.debugLogs)
      .orderBy(desc(this.debugLogs.createdAt), desc(this.debugLogs.eventId))
      .offset(maxEntries);
    if (!rows.length) return;
    await this.db.delete(this.debugLogs).where(
      inArray(
        this.debugLogs.eventId,
        rows.map((row) => row.eventId),
      ),
    );
  }

  public async getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null> {
    const rows = await this.db
      .select({
        encryptedPayload: this.documents.encryptedPayload,
        encryptionMode: this.documents.encryptionMode,
        key: this.documents.documentKey,
        payload: this.documents.payload,
      })
      .from(this.documents)
      .where(
        and(
          eq(this.documents.namespace, namespace),
          eq(this.documents.documentKey, key),
        ),
      )
      .limit(1);

    const row = rows[0];

    if (!row) {
      return null;
    }

    return row;
  }

  public async listDocuments(
    namespace: string,
  ): Promise<DatabaseDocumentRecord[]> {
    const rows = await this.db
      .select({
        encryptedPayload: this.documents.encryptedPayload,
        encryptionMode: this.documents.encryptionMode,
        key: this.documents.documentKey,
        payload: this.documents.payload,
      })
      .from(this.documents)
      .where(eq(this.documents.namespace, namespace))
      .orderBy(asc(this.documents.documentKey));

    return rows;
  }

  public async putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void> {
    await this.db
      .insert(this.documents)
      .values({
        documentKey: input.key,
        encryptedPayload: input.encryptedPayload,
        encryptionMode: input.encryptionMode,
        namespace: input.namespace,
        payload: input.payload,
      })
      .onConflictDoUpdate({
        set: {
          encryptedPayload: input.encryptedPayload,
          encryptionMode: input.encryptionMode,
          payload: input.payload,
          updatedAt: new Date(),
        },
        target: [this.documents.namespace, this.documents.documentKey],
      });
  }

  public async deleteDocument(namespace: string, key: string): Promise<void> {
    await this.db
      .delete(this.documents)
      .where(
        and(
          eq(this.documents.namespace, namespace),
          eq(this.documents.documentKey, key),
        ),
      );
  }
}
