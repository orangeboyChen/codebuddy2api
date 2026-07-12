import { index, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const createStorageSchema = (schemaName: string) => {
  const schema = pgSchema(schemaName);

  const documents = schema.table(
    'documents',
    {
      namespace: text('namespace').notNull(),
      documentKey: text('document_key').notNull(),
      payload: text('payload'),
      encryptedPayload: text('encrypted_payload'),
      encryptionMode: text('encryption_mode'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      namespaceIdx: index('documents_namespace_idx').on(table.namespace),
    }),
  );

  return {
    documents,
    schema,
  };
};
