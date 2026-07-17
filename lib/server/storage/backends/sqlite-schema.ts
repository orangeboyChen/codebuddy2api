import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const documents = sqliteTable(
  'documents',
  {
    namespace: text('namespace').notNull(),
    documentKey: text('document_key').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    encryptedPayload: text('encrypted_payload'),
    encryptionMode: text('encryption_mode'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespace, table.documentKey],
      name: 'documents_namespace_document_key_pk',
    }),
  ],
);

export const usageEvents = sqliteTable(
  'usage_events',
  {
    eventId: text('event_id').primaryKey(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
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
  (table) => [
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

export const debugLogs = sqliteTable(
  'debug_logs',
  {
    eventId: text('event_id').primaryKey(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    credentialFilename: text('credential_filename'),
    elapsedMs: integer('elapsed_ms'),
    error: text('error'),
    model: text('model'),
    requestKey: text('request_key'),
    route: text('route').notNull(),
    requestBody: text('request_body', { mode: 'json' }).$type<unknown>(),
    transformedResponse: text('transformed_response', {
      mode: 'json',
    }).$type<unknown>(),
    upstreamRequest: text('upstream_request', {
      mode: 'json',
    }).$type<unknown>(),
    upstreamResponse: text('upstream_response', {
      mode: 'json',
    }).$type<unknown>(),
    usage: text('usage', { mode: 'json' }).$type<unknown>(),
  },
  (table) => [
    index('debug_logs_created_at_idx').on(table.createdAt, table.eventId),
  ],
);
