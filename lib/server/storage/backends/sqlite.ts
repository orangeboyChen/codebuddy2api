import Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';

import { debugLogs, documents, usageEvents } from './sqlite-schema';
import type {
  DatabaseDocumentRecord,
  DatabaseStorageAdapter,
  StorageEvent,
} from './types';

interface SqliteDatabaseStorageAdapterOptions {
  path: string;
}

export class DrizzleSqliteDatabaseStorageAdapter implements DatabaseStorageAdapter {
  private readonly db: ReturnType<typeof drizzle>;

  private readonly sqlite: InstanceType<typeof Database>;

  public constructor(options: SqliteDatabaseStorageAdapterOptions) {
    this.sqlite = new Database(options.path);
    this.db = drizzle(this.sqlite);
  }

  public async ensureSchema(): Promise<void> {
    migrate(this.db, {
      migrationsFolder: path.resolve('lib/server/storage/migrations/sqlite'),
    });

    await Promise.all([
      this.db.select({ key: documents.documentKey }).from(documents).limit(1),
      this.db.select({ key: usageEvents.eventId }).from(usageEvents).limit(1),
      this.db.select({ key: debugLogs.eventId }).from(debugLogs).limit(1),
    ]);
  }

  public async appendUsageEvents(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;

    await this.db
      .insert(usageEvents)
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
      .from(usageEvents)
      .where(gte(usageEvents.occurredAt, since))
      .orderBy(asc(usageEvents.occurredAt), asc(usageEvents.eventId));

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
    await this.db.delete(usageEvents);
  }

  public async trimUsageEvents(before: Date): Promise<void> {
    await this.db.delete(usageEvents).where(lt(usageEvents.occurredAt, before));
  }

  public async appendDebugLogs(entries: StorageEvent[]): Promise<void> {
    if (!entries.length) return;

    await this.db
      .insert(debugLogs)
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
          createdAt: new Date(entry.timestamp),
          eventId: entry.id,
        })),
      )
      .onConflictDoNothing();
  }

  public async listDebugLogs(limit: number): Promise<StorageEvent[]> {
    const rows = await this.db
      .select()
      .from(debugLogs)
      .orderBy(desc(debugLogs.createdAt), desc(debugLogs.eventId))
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
    await this.db.delete(debugLogs);
  }

  public async trimDebugLogs(maxEntries: number): Promise<void> {
    const rows = await this.db
      .select({ eventId: debugLogs.eventId })
      .from(debugLogs)
      .orderBy(desc(debugLogs.createdAt), desc(debugLogs.eventId));
    const staleRows = rows.slice(maxEntries);

    if (!staleRows.length) return;

    await this.db.delete(debugLogs).where(
      inArray(
        debugLogs.eventId,
        staleRows.map((row) => row.eventId),
      ),
    );
  }

  public async getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null> {
    const rows = await this.db
      .select({
        encryptedPayload: documents.encryptedPayload,
        encryptionMode: documents.encryptionMode,
        key: documents.documentKey,
        payload: documents.payload,
      })
      .from(documents)
      .where(
        and(eq(documents.namespace, namespace), eq(documents.documentKey, key)),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  public async listDocuments(
    namespace: string,
  ): Promise<DatabaseDocumentRecord[]> {
    return this.db
      .select({
        encryptedPayload: documents.encryptedPayload,
        encryptionMode: documents.encryptionMode,
        key: documents.documentKey,
        payload: documents.payload,
      })
      .from(documents)
      .where(eq(documents.namespace, namespace))
      .orderBy(asc(documents.documentKey));
  }

  public async putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void> {
    await this.db
      .insert(documents)
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
        target: [documents.namespace, documents.documentKey],
      });
  }

  public async deleteDocument(namespace: string, key: string): Promise<void> {
    await this.db
      .delete(documents)
      .where(
        and(eq(documents.namespace, namespace), eq(documents.documentKey, key)),
      );
  }
}
