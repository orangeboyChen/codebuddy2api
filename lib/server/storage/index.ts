import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type DatabaseStorageAdapter,
  DrizzlePgDatabaseStorageAdapter,
} from './database';

export type StorageBackendKind = 'file' | 'pg';

interface JsonDocument<T> {
  key: string;
  value: T;
}

export interface StorageJsonReadResult<T> {
  error: string | null;
  exists: boolean;
  value: T | null;
}

interface StorageBackend {
  deleteJson(namespace: string, key: string): Promise<void>;
  getJson<T>(namespace: string, key: string): Promise<T | null>;
  initialize(): Promise<void>;
  listJson<T>(namespace: string): Promise<Array<JsonDocument<T>>>;
  putJson<T>(namespace: string, key: string, value: T): Promise<void>;
}

interface DatabaseBackendFactory {
  createAdapter(): DatabaseStorageAdapter;
}

interface StorageRuntime {
  backend: StorageBackend;
  initialized: boolean;
  initializing: Promise<void> | null;
}

const STORAGE_KIND_ENV = 'CODEBUDDY_STORAGE_BACKEND';
const STORAGE_PG_URL_ENV = 'CODEBUDDY_STORAGE_PG_URL';
const STORAGE_PG_SCHEMA_ENV = 'CODEBUDDY_STORAGE_PG_SCHEMA';
const STORAGE_IMPORT_ENV = 'CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES';
const STORAGE_ENCRYPTION_KEY_ENV = 'CODEBUDDY_STORAGE_ENCRYPTION_KEY';
const STORAGE_PERSISTENCE_ENV = 'CODEBUDDY_STORAGE_PERSISTENCE';
const STORAGE_FILE_DIR_ENV = 'CODEBUDDY_STORAGE_FILE_DIR';
const LEGACY_CONFIG_PATH_ENV = 'CODEBUDDY_CONFIG_PATH';

const CREDENTIAL_MANAGER_STATE_FILENAME = 'manager_state.json';

const globalStorageState = globalThis as typeof globalThis & {
  __codebuddy2apiStorage__?: StorageRuntime;
};

const resolveFileStorageDir = (): string => {
  const explicitDir = process.env[STORAGE_FILE_DIR_ENV]?.trim();

  if (explicitDir) {
    return path.resolve(/* turbopackIgnore: true */ process.cwd(), explicitDir);
  }

  const legacyConfigPath = process.env[LEGACY_CONFIG_PATH_ENV]?.trim();

  if (legacyConfigPath) {
    return path.dirname(
      path.resolve(/* turbopackIgnore: true */ process.cwd(), legacyConfigPath),
    );
  }

  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    '.codebuddy_data',
  );
};

const getLegacyConfigPath = (): string | null => {
  const legacyConfigPath = process.env[LEGACY_CONFIG_PATH_ENV]?.trim();

  if (!legacyConfigPath) {
    return null;
  }

  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    legacyConfigPath,
  );
};

export const getFileStorageDir = (): string => {
  return resolveFileStorageDir();
};

export const getConfigPath = (): string => {
  return (
    getLegacyConfigPath() ?? path.join(resolveFileStorageDir(), 'runtime.json')
  );
};

export const getConfigDir = (): string => {
  return path.dirname(getConfigPath());
};

export const getCredsDir = (): string => {
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    '.codebuddy_creds',
  );
};

const getStorageBackendKind = (): StorageBackendKind => {
  const value = process.env[STORAGE_KIND_ENV]?.trim().toLowerCase();
  const persistence =
    process.env[STORAGE_PERSISTENCE_ENV]?.trim().toLowerCase();
  const hasPgConnection =
    Boolean(process.env[STORAGE_PG_URL_ENV]?.trim()) ||
    Boolean(process.env.DATABASE_URL?.trim());

  if (value === 'file' || persistence === 'file') {
    return 'file';
  }

  if (value === 'pg' || persistence === 'pg') {
    return 'pg';
  }

  if (hasPgConnection) {
    return 'pg';
  }

  return 'file';
};

const getPgSchema = (): string => {
  const raw = process.env[STORAGE_PG_SCHEMA_ENV]?.trim();

  if (!raw) {
    return 'codebuddy2api';
  }

  return raw.replace(/[^a-zA-Z0-9_]/g, '_') || 'codebuddy2api';
};

const shouldImportLegacyFiles = (): boolean => {
  const raw = process.env[STORAGE_IMPORT_ENV]?.trim().toLowerCase();

  if (!raw) {
    return true;
  }

  return raw !== 'false' && raw !== '0' && raw !== 'no';
};

const readJsonFileDetailed = <T>(
  filePath: string,
): StorageJsonReadResult<T> => {
  if (!fs.existsSync(filePath)) {
    return {
      error: null,
      exists: false,
      value: null,
    };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();

    if (!content) {
      return {
        error: 'JSON file is empty',
        exists: true,
        value: null,
      };
    }

    return {
      error: null,
      exists: true,
      value: JSON.parse(content) as T,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : 'Failed to parse JSON file',
      exists: true,
      value: null,
    };
  }
};

const readJsonFile = <T>(filePath: string): T | null => {
  return readJsonFileDetailed<T>(filePath).value;
};

const writeJsonFile = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const getDocumentPath = (namespace: string, key: string): string => {
  if (namespace === 'config' && key === 'runtime') {
    return getConfigPath();
  }

  if (namespace === 'access-keys' && key === 'store') {
    return path.join(getFileStorageDir(), 'access-keys.json');
  }

  if (namespace === 'debug' && key === 'settings') {
    return path.join(getFileStorageDir(), 'debug-settings.json');
  }

  if (namespace === 'debug' && key === 'logs') {
    return path.join(getFileStorageDir(), 'debug-logs.json');
  }

  if (namespace === 'usage' && key === 'history') {
    return path.join(getFileStorageDir(), 'usage-history.json');
  }

  if (namespace === 'admin-auth' && key === 'state') {
    return path.join(getFileStorageDir(), 'admin-auth.json');
  }

  if (
    namespace === 'credentials' &&
    key === CREDENTIAL_MANAGER_STATE_FILENAME
  ) {
    return path.join(getCredsDir(), CREDENTIAL_MANAGER_STATE_FILENAME);
  }

  if (namespace === 'credentials') {
    return path.join(getCredsDir(), key);
  }

  throw new Error(`Unsupported storage document: ${namespace}/${key}`);
};

const getLegacyDocumentPath = (
  namespace: string,
  key: string,
): string | null => {
  const legacyConfigPath = process.env[LEGACY_CONFIG_PATH_ENV]?.trim();
  const legacyConfigDir = legacyConfigPath
    ? path.dirname(
        path.resolve(
          /* turbopackIgnore: true */ process.cwd(),
          legacyConfigPath,
        ),
      )
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), 'config');
  const legacyFilename =
    namespace === 'config' && key === 'runtime'
      ? 'config.json'
      : namespace === 'access-keys' && key === 'store'
        ? 'access-keys.json'
        : namespace === 'debug' && key === 'settings'
          ? 'debug-config.json'
          : namespace === 'debug' && key === 'logs'
            ? 'debug-logs.json'
            : namespace === 'usage' && key === 'history'
              ? 'usage/history.json'
              : null;

  if (!legacyFilename) {
    return null;
  }

  const legacyPath = path.join(legacyConfigDir, legacyFilename);

  return legacyPath === getDocumentPath(namespace, key) ? null : legacyPath;
};

const readFileStorageDocument = <T>(
  namespace: string,
  key: string,
  migrateLegacy = true,
): StorageJsonReadResult<T> => {
  const documentPath = getDocumentPath(namespace, key);
  const current = readJsonFileDetailed<T>(documentPath);

  if (current.exists) {
    return current;
  }

  const legacyPath = getLegacyDocumentPath(namespace, key);

  if (!legacyPath) {
    return current;
  }

  const legacy = readJsonFileDetailed<T>(legacyPath);

  if (!legacy.exists || legacy.value === null) {
    return legacy.exists ? legacy : current;
  }

  if (migrateLegacy) {
    writeJsonFile(documentPath, legacy.value);
  }

  return legacy;
};

const listCredentialFiles = (): string[] => {
  if (!fs.existsSync(getCredsDir())) {
    return [];
  }

  return fs
    .readdirSync(getCredsDir())
    .filter(
      (item) =>
        item.endsWith('.json') && item !== CREDENTIAL_MANAGER_STATE_FILENAME,
    )
    .sort((left, right) => left.localeCompare(right));
};

const createEncryptionKey = (): Buffer | null => {
  const source = process.env[STORAGE_ENCRYPTION_KEY_ENV]?.trim();

  if (!source) {
    return null;
  }

  return crypto.createHash('sha256').update(source).digest();
};

const encryptPayload = (
  value: unknown,
): { ciphertext: string; mode: string } => {
  const key = createEncryptionKey();

  if (!key) {
    return {
      ciphertext: JSON.stringify(value),
      mode: 'plain-json',
    };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([iv, tag, ciphertext]).toString('base64'),
    mode: 'aes-256-gcm',
  };
};

const decryptPayload = <T>(ciphertext: string, mode: string): T => {
  if (mode === 'plain-json') {
    return JSON.parse(ciphertext) as T;
  }

  const key = createEncryptionKey();

  if (!key) {
    throw new Error(
      'Encrypted storage requires CODEBUDDY_STORAGE_ENCRYPTION_KEY',
    );
  }

  const buffer = Buffer.from(ciphertext, 'base64');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext) as T;
};

class FileStorageBackend implements StorageBackend {
  public async initialize(): Promise<void> {}

  public async getJson<T>(namespace: string, key: string): Promise<T | null> {
    return readFileStorageDocument<T>(namespace, key).value;
  }

  public async listJson<T>(namespace: string): Promise<Array<JsonDocument<T>>> {
    if (namespace !== 'credentials') {
      throw new Error(
        `Unsupported list namespace for file backend: ${namespace}`,
      );
    }

    const documents: Array<JsonDocument<T>> = [];

    listCredentialFiles().forEach((key) => {
      const value = readJsonFile<T>(getDocumentPath(namespace, key));

      if (value !== null) {
        documents.push({ key, value });
      }
    });

    return documents;
  }

  public async putJson<T>(
    namespace: string,
    key: string,
    value: T,
  ): Promise<void> {
    writeJsonFile(getDocumentPath(namespace, key), value);
  }

  public async deleteJson(namespace: string, key: string): Promise<void> {
    fs.rmSync(getDocumentPath(namespace, key), { force: true });
  }
}

class PgDatabaseFactory implements DatabaseBackendFactory {
  public createAdapter(): DatabaseStorageAdapter {
    const connectionString =
      process.env[STORAGE_PG_URL_ENV]?.trim() ||
      process.env.DATABASE_URL?.trim();

    if (!connectionString) {
      throw new Error(
        `${STORAGE_PG_URL_ENV} or DATABASE_URL is required when storage backend is pg`,
      );
    }

    return new DrizzlePgDatabaseStorageAdapter({
      connectionString,
      schemaName: getPgSchema(),
    });
  }
}

class DatabaseStorageBackend implements StorageBackend {
  private adapter: DatabaseStorageAdapter;

  public constructor(factory: DatabaseBackendFactory) {
    this.adapter = factory.createAdapter();
  }

  public async initialize(): Promise<void> {
    await this.adapter.ensureSchema();

    if (shouldImportLegacyFiles()) {
      await this.importLegacyFiles();
    }
  }

  public async getJson<T>(namespace: string, key: string): Promise<T | null> {
    const row = await this.adapter.getDocument(namespace, key);

    if (!row) {
      return null;
    }

    if (row.encryptedPayload && row.encryptionMode) {
      return decryptPayload<T>(row.encryptedPayload, row.encryptionMode);
    }

    if (typeof row.payload !== 'string') {
      return row.payload as T;
    }

    return JSON.parse(row.payload) as T;
  }

  public async listJson<T>(namespace: string): Promise<Array<JsonDocument<T>>> {
    const rows = await this.adapter.listDocuments(namespace);

    return rows.map((row) => ({
      key: row.key,
      value:
        row.encryptedPayload && row.encryptionMode
          ? decryptPayload<T>(row.encryptedPayload, row.encryptionMode)
          : typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as T)
            : (row.payload as T),
    }));
  }

  public async putJson<T>(
    namespace: string,
    key: string,
    value: T,
  ): Promise<void> {
    const sensitive =
      namespace === 'credentials' ||
      (namespace === 'access-keys' && key === 'store');

    if (sensitive) {
      const encrypted = encryptPayload(value);
      await this.adapter.putDocument({
        encryptedPayload: encrypted.ciphertext,
        encryptionMode: encrypted.mode,
        key,
        namespace,
        payload: null,
      });
      return;
    }

    await this.adapter.putDocument({
      encryptedPayload: null,
      encryptionMode: null,
      key,
      namespace,
      payload: value,
    });
  }

  public async deleteJson(namespace: string, key: string): Promise<void> {
    await this.adapter.deleteDocument(namespace, key);
  }

  private async importLegacyDocument(
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    const existing = await this.getJson(namespace, key);

    if (existing !== null) {
      return;
    }

    await this.putJson(namespace, key, value);
  }

  private async importLegacyFiles(): Promise<void> {
    const singletons: Array<{ key: string; namespace: string }> = [
      { namespace: 'config', key: 'runtime' },
      { namespace: 'admin-auth', key: 'state' },
      { namespace: 'access-keys', key: 'store' },
      { namespace: 'debug', key: 'settings' },
      { namespace: 'debug', key: 'logs' },
      { namespace: 'usage', key: 'history' },
      { namespace: 'credentials', key: CREDENTIAL_MANAGER_STATE_FILENAME },
    ];

    for (const document of singletons) {
      const value = readFileStorageDocument<unknown>(
        document.namespace,
        document.key,
        false,
      ).value;

      if (value !== null) {
        await this.importLegacyDocument(
          document.namespace,
          document.key,
          value,
        );
      }
    }

    for (const key of listCredentialFiles()) {
      const value = readJsonFile<unknown>(getDocumentPath('credentials', key));

      if (value !== null) {
        await this.importLegacyDocument('credentials', key, value);
      }
    }
  }
}

const createBackend = (): StorageBackend => {
  return getStorageBackendKind() === 'pg'
    ? new DatabaseStorageBackend(new PgDatabaseFactory())
    : new FileStorageBackend();
};

const getRuntime = (): StorageRuntime => {
  if (!globalStorageState.__codebuddy2apiStorage__) {
    globalStorageState.__codebuddy2apiStorage__ = {
      backend: createBackend(),
      initialized: false,
      initializing: null,
    };
  }

  return globalStorageState.__codebuddy2apiStorage__;
};

export const ensureStorageReady = async (): Promise<void> => {
  const runtime = getRuntime();

  if (runtime.initialized) {
    return;
  }

  if (!runtime.initializing) {
    runtime.initializing = runtime.backend
      .initialize()
      .then(() => {
        runtime.initialized = true;
      })
      .finally(() => {
        runtime.initializing = null;
      });
  }

  await runtime.initializing;
};

export const readStorageJson = async <T>(
  namespace: string,
  key: string,
): Promise<T | null> => {
  await ensureStorageReady();
  return getRuntime().backend.getJson<T>(namespace, key);
};

export const readStorageJsonResult = async <T>(
  namespace: string,
  key: string,
): Promise<StorageJsonReadResult<T>> => {
  await ensureStorageReady();

  if (getStorageBackendKind() === 'file') {
    return readFileStorageDocument<T>(namespace, key);
  }

  return {
    error: null,
    exists: true,
    value: await getRuntime().backend.getJson<T>(namespace, key),
  };
};

export const listStorageJson = async <T>(
  namespace: string,
): Promise<Array<JsonDocument<T>>> => {
  await ensureStorageReady();
  return getRuntime().backend.listJson<T>(namespace);
};

export const writeStorageJson = async <T>(
  namespace: string,
  key: string,
  value: T,
): Promise<void> => {
  await ensureStorageReady();
  await getRuntime().backend.putJson(namespace, key, value);
};

export const deleteStorageJson = async (
  namespace: string,
  key: string,
): Promise<void> => {
  await ensureStorageReady();
  await getRuntime().backend.deleteJson(namespace, key);
};

export const resetStorageRuntime = (): void => {
  delete globalStorageState.__codebuddy2apiStorage__;
};

export const getStorageBackendMeta = (): {
  backend: StorageBackendKind;
  encryptionEnabled: boolean;
  schema: string | null;
} => {
  const backend = getStorageBackendKind();

  return {
    backend,
    encryptionEnabled: Boolean(process.env[STORAGE_ENCRYPTION_KEY_ENV]?.trim()),
    schema: backend === 'pg' ? getPgSchema() : null,
  };
};
