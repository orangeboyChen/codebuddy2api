import path from 'node:path';

import { defineConfig } from 'drizzle-kit';

const storageRoot = path.resolve(process.cwd(), 'lib', 'server', 'storage');
const backend = process.env.CODEBUDDY_STORAGE_BACKEND?.trim().toLowerCase();
const sqlitePath = process.env.CODEBUDDY_STORAGE_SQLITE_PATH?.trim();

export default defineConfig(
  backend === 'sqlite'
    ? {
        dbCredentials: {
          url: sqlitePath
            ? path.resolve(process.cwd(), sqlitePath)
            : path.resolve(process.cwd(), '.codebuddy_data/storage.sqlite'),
        },
        dialect: 'sqlite',
        out: path.join(storageRoot, 'migrations', 'sqlite'),
        schema: path.join(storageRoot, 'backends', 'sqlite-schema.ts'),
      }
    : {
        dbCredentials: {
          url:
            process.env.CODEBUDDY_STORAGE_PG_URL ??
            process.env.DATABASE_URL ??
            '',
        },
        dialect: 'postgresql',
        out: path.join(storageRoot, 'migrations', 'postgres'),
        schema: path.join(storageRoot, 'backends', 'postgres-schema.ts'),
      },
);
