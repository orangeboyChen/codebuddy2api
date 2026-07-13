export interface DatabaseDocumentRecord {
  encryptedPayload: string | null;
  encryptionMode: string | null;
  key: string;
  payload: unknown;
}

export interface StorageEvent {
  id: string;
  payload: unknown;
  timestamp: string;
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
