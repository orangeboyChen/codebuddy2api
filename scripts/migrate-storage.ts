import {
  getStorageBackendMeta,
  migrateStorageSchema,
} from '../lib/server/storage';

const migrateStorage = async (): Promise<void> => {
  if (getStorageBackendMeta().backend !== 'pg') {
    throw new Error('CODEBUDDY_STORAGE_BACKEND=pg is required for migration');
  }

  await migrateStorageSchema();
  console.info(
    'Legacy file storage import completed. The operation is idempotent.',
  );
};

void migrateStorage();
