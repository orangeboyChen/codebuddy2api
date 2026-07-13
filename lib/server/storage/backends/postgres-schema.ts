import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  type PgTableExtraConfigValue,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const createPostgresStorageSchema = (schemaName: string) => {
  const schema = pgSchema(schemaName);

  const documents = schema.table(
    'documents',
    {
      namespace: text('namespace').notNull(),
      documentKey: text('document_key').notNull(),
      payload: jsonb('payload'),
      encryptedPayload: text('encrypted_payload'),
      encryptionMode: text('encryption_mode'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      primaryKey({
        columns: [table.namespace, table.documentKey],
        name: 'documents_namespace_document_key_pk',
      }),
    ],
  );

  const usageEvents = schema.table(
    'usage_events',
    {
      eventId: text('event_id').primaryKey(),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
      accessKeyId: text('access_key_id'),
      accessKeyName: text('access_key_name'),
      cacheCreationTokens: integer('cache_creation_tokens').notNull(),
      cacheReadTokens: integer('cache_read_tokens').notNull(),
      callCount: integer('call_count').notNull(),
      credentialFilename: text('credential_filename'),
      inputTokens: integer('input_tokens').notNull(),
      model: text('model').notNull(),
      outputTokens: integer('output_tokens').notNull(),
      route: text('route').notNull(),
      totalTokens: integer('total_tokens').notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      index('usage_events_occurred_at_idx').on(table.occurredAt, table.eventId),
      index('usage_events_credential_occurred_at_idx').on(
        table.credentialFilename,
        table.occurredAt,
        table.eventId,
      ),
      index('usage_events_access_key_occurred_at_idx').on(
        table.accessKeyId,
        table.occurredAt,
        table.eventId,
      ),
    ],
  );

  const debugLogs = schema.table(
    'debug_logs',
    {
      eventId: text('event_id').primaryKey(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      credentialFilename: text('credential_filename'),
      error: text('error'),
      requestKey: text('request_key'),
      route: text('route').notNull(),
      requestBody: jsonb('request_body'),
      transformedResponse: jsonb('transformed_response'),
      upstreamRequest: jsonb('upstream_request'),
      upstreamResponse: jsonb('upstream_response'),
    },
    (table): PgTableExtraConfigValue[] => [
      index('debug_logs_created_at_idx').on(
        table.createdAt.desc(),
        table.eventId.desc(),
      ),
    ],
  );

  return { debugLogs, documents, schema, usageEvents };
};

export const {
  debugLogs: postgresDebugLogs,
  documents: postgresDocuments,
  usageEvents: postgresUsageEvents,
} = createPostgresStorageSchema('codebuddy2api');
