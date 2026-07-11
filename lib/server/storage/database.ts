import { and, asc, eq, sql } from 'drizzle-orm';
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
  deleteDocument(namespace: string, key: string): Promise<void>;
  ensureSchema(): Promise<void>;
  getDocument(
    namespace: string,
    key: string,
  ): Promise<DatabaseDocumentRecord | null>;
  listDocuments(namespace: string): Promise<DatabaseDocumentRecord[]>;
  putDocument(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void>;
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

  private readonly pool: InstanceType<typeof Pool>;

  private readonly schemaName: string;

  public constructor(options: PgDatabaseStorageAdapterOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
    });
    this.db = drizzle(this.pool);
    this.schemaName = options.schemaName;
    this.documents = createStorageSchema(options.schemaName).documents;
  }

  public async ensureSchema(): Promise<void> {
    await this.db.execute(
      sql.raw(`CREATE SCHEMA IF NOT EXISTS "${this.schemaName}"`),
    );
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${this.documents} (
        namespace TEXT NOT NULL,
        document_key TEXT NOT NULL,
        payload TEXT,
        encrypted_payload TEXT,
        encryption_mode TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, document_key)
      )
    `);
    await this.db.execute(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS "documents_namespace_idx" ON "${this.schemaName}"."documents" (namespace)`,
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
        payload: input.payload === null ? null : JSON.stringify(input.payload),
      })
      .onConflictDoUpdate({
        set: {
          encryptedPayload: input.encryptedPayload,
          encryptionMode: input.encryptionMode,
          payload:
            input.payload === null ? null : JSON.stringify(input.payload),
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
