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
  /**
   * Writes the document only when no row exists for its namespace and key.
   * Used where concurrent writers must agree on one value: an upsert would
   * let the last writer win while the loser keeps using the value it
   * generated, which is how two instances end up disagreeing on a key.
   */
  putDocumentIfAbsent(input: {
    encryptedPayload: string | null;
    encryptionMode: string | null;
    key: string;
    namespace: string;
    payload: unknown;
  }): Promise<void>;
  trimDebugLogs(maxEntries: number): Promise<void>;
  trimUsageEvents(before: Date): Promise<void>;
}
