import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { createStorageSchema } from './schema';

export interface DatabaseDocumentRecord {
  encryptedPayload: string | null;
  encryptionMode: string | null;
  key: string;
  payload: unknown;
}

export interface DatabaseStorageAdapter {
  appendDebugLogs(entries: StorageEvent[]): Promise<void>;
  appendUsageEvents(entries: StorageEvent[]): Promise<void>;
  clearDebugLogs(): Promise<void>;
  clearUsageEvents(): Promise<void>;
  deleteDocument(namespace: string, key: string): Promise<void>;
  ensureSchema(): Promise<void>;
  getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null>;
  listDocuments(namespace: string): Promise<DatabaseDocumentRecord[]>;
  listDebugLogs(limit: number): Promise<StorageEvent[]>;
  listUsageEvents(since: Date): Promise<StorageEvent[]>;
  migrateSchema(): Promise<void>;
  putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void>;
  trimDebugLogs(maxEntries: number): Promise<void>;
  trimUsageEvents(before: Date): Promise<void>;
}

export interface StorageEvent {
  id: string;
  payload: unknown;
  timestamp: string;
}

interface PgDatabaseStorageAdapterOptions {
  connectionString: string;
  schemaName: string;
}

export class DrizzlePgDatabaseStorageAdapter implements DatabaseStorageAdapter {
  private readonly db: ReturnType<typeof drizzle>;

  private readonly documents: ReturnType<
    typeof createStorageSchema
  >['documents'];

  private readonly debugLogs: ReturnType<
    typeof createStorageSchema
  >['debugLogs'];

  private readonly pool: InstanceType<typeof Pool>;

  private readonly schemaName: string;

  private readonly usageEvents: ReturnType<
    typeof createStorageSchema
  >['usageEvents'];

  public constructor(options: PgDatabaseStorageAdapterOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
    });
    this.db = drizzle(this.pool);
    this.schemaName = options.schemaName;
    const schema = createStorageSchema(options.schemaName);
    this.documents = schema.documents;
    this.debugLogs = schema.debugLogs;
    this.usageEvents = schema.usageEvents;
  }

  public async ensureSchema(): Promise<void> {
    await Promise.all([
      this.db
        .select({ key: this.documents.documentKey })
        .from(this.documents)
        .where(sql`TRUE`)
        .limit(1),
      this.db
        .select({ key: this.usageEvents.eventId })
        .from(this.usageEvents)
        .where(sql`TRUE`)
        .limit(1),
      this.db
        .select({ key: this.debugLogs.eventId })
        .from(this.debugLogs)
        .where(sql`TRUE`)
        .limit(1),
    ]);
  }

  public async migrateSchema(): Promise<void> {
    await this.db.execute(
      sql.raw(`CREATE SCHEMA IF NOT EXISTS "${this.schemaName}"`),
    );
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${this.usageEvents} (
        event_id TEXT PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL,
        access_key_id TEXT,
        access_key_name TEXT,
        cache_creation_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        credential_filename TEXT,
        input_tokens INTEGER NOT NULL,
        model TEXT NOT NULL,
        output_tokens INTEGER NOT NULL,
        route TEXT NOT NULL,
        total_tokens INTEGER NOT NULL
      )
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${this.debugLogs} (
        event_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        credential_filename TEXT,
        error TEXT,
        request_key TEXT,
        route TEXT NOT NULL,
        request_body JSONB,
        transformed_response JSONB,
        upstream_request JSONB,
        upstream_response JSONB
      )
    `);
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${this.documents} (
        namespace TEXT NOT NULL,
        document_key TEXT NOT NULL,
        payload JSONB,
        encrypted_payload TEXT,
        encryption_mode TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, document_key)
      )
    `);
    await this.db.execute(sql`
      ALTER TABLE ${this.documents}
      ALTER COLUMN payload TYPE JSONB USING payload::JSONB
    `);
    await this.db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "usage_events_credential_occurred_at_idx" ON "${this.schemaName}"."usage_events" (credential_filename, occurred_at, event_id)`,
      ),
    );
    await this.db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "usage_events_access_key_occurred_at_idx" ON "${this.schemaName}"."usage_events" (access_key_id, occurred_at, event_id)`,
      ),
    );
    await this.db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "usage_events_occurred_at_idx" ON "${this.schemaName}"."usage_events" (occurred_at, event_id)`,
      ),
    );
    await this.db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "debug_logs_created_at_idx" ON "${this.schemaName}"."debug_logs" (created_at DESC, event_id DESC)`,
      ),
    );
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
      .where(sql`${this.usageEvents.occurredAt} < ${before}`);
  }

  public async appendDebugLogs(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;
    await this.db
      .insert(this.debugLogs)
      .values(
        entries.map((entry) => ({
          ...(entry.payload as {
            credentialFilename: string | null;
            error: string | null;
            requestBody: unknown;
            requestKey: string | null;
            route: string;
            transformedResponse: unknown;
            upstreamRequest: unknown;
            upstreamResponse: unknown;
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
        error: row.error,
        id: row.eventId,
        requestBody: row.requestBody,
        requestKey: row.requestKey,
        route: row.route,
        transformedResponse: row.transformedResponse,
        upstreamRequest: row.upstreamRequest,
        upstreamResponse: row.upstreamResponse,
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
          updatedAt: sql`NOW()`,
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
