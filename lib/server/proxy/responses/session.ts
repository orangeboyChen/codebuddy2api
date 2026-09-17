// ---------------------------------------------------------------------------
// Response session persistence
// ---------------------------------------------------------------------------

import type { ProxyContext } from '../codebuddy';
import {
  deleteStorageJson,
  getStorageBackendMeta,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../../storage';
import type { ResponseSession, ResponseSessionMetadata } from './types';

export const MAX_RESPONSE_SESSIONS = 1_000;
export const RESPONSE_SESSION_TTL_MS = 60 * 60 * 1000;
export const MAX_RESPONSE_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_SESSION_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_RESPONSE_TRANSCRIPT_MESSAGES = 200;
export const RESPONSE_SESSION_NAMESPACE = 'responses';
export const RESPONSE_SESSION_INDEX_NAMESPACE = 'response-session-index';

const globalResponsesState = globalThis as typeof globalThis & {
  __codebuddy2apiResponseSessions__?: Map<string, ResponseSession>;
  __codebuddy2apiResponseSessionBytes__?: Map<string, number>;
  __codebuddy2apiResponseSessionTotalBytes__?: number;
};

export const getSessionStore = (): Map<string, ResponseSession> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessions__) {
    globalResponsesState.__codebuddy2apiResponseSessions__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessions__;
};

export const getSessionByteStore = (): Map<string, number> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessionBytes__) {
    globalResponsesState.__codebuddy2apiResponseSessionBytes__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessionBytes__;
};

export const getSessionTotalBytes = (): number => {
  return globalResponsesState.__codebuddy2apiResponseSessionTotalBytes__ ?? 0;
};

export const setSessionTotalBytes = (value: number): void => {
  globalResponsesState.__codebuddy2apiResponseSessionTotalBytes__ = value;
};

export const removeLocalResponseSession = (id: string): void => {
  const byteStore = getSessionByteStore();
  const store = getSessionStore();
  const bytes = byteStore.get(id) ?? 0;
  store.delete(id);
  byteStore.delete(id);
  setSessionTotalBytes(Math.max(0, getSessionTotalBytes() - bytes));
};

export const pruneResponseSessions = (): void => {
  const store = getSessionStore();
  const expiresBefore = Date.now() - RESPONSE_SESSION_TTL_MS;

  for (const [id, session] of store) {
    if (session.createdAt <= expiresBefore) {
      removeLocalResponseSession(id);
    }
  }

  while (
    store.size > MAX_RESPONSE_SESSIONS ||
    getSessionTotalBytes() > MAX_RESPONSE_SESSION_TOTAL_BYTES
  ) {
    const oldestId = store.keys().next().value;

    // Guard against a byte total that has drifted out of step with the map.
    // Without this, an empty map with a positive total makes the removal a
    // no-op and spins here forever, blocking the event loop.
    if (oldestId === undefined) {
      setSessionTotalBytes(0);
      break;
    }

    removeLocalResponseSession(oldestId);
  }
};

export const prunePgResponseSessions = async (): Promise<void> => {
  const metadataDocuments = await listStorageJson<ResponseSessionMetadata>(
    RESPONSE_SESSION_INDEX_NAMESPACE,
  );
  const expiresBefore = Date.now() - RESPONSE_SESSION_TTL_MS;
  const candidates = metadataDocuments
    .map((document) => ({ key: document.key, ...document.value }))
    .sort((left, right) => left.createdAt - right.createdAt);
  const toDelete = candidates.filter(
    (candidate) => candidate.createdAt <= expiresBefore,
  );
  const remaining = candidates.filter(
    (candidate) => candidate.createdAt > expiresBefore,
  );
  let totalBytes = remaining.reduce(
    (total, candidate) => total + candidate.bytes,
    0,
  );

  while (
    remaining.length > MAX_RESPONSE_SESSIONS ||
    totalBytes > MAX_RESPONSE_SESSION_TOTAL_BYTES
  ) {
    const candidate = remaining.shift()!;
    toDelete.push(candidate);
    totalBytes -= candidate.bytes;
  }

  await Promise.all(
    toDelete.flatMap((candidate) => [
      deleteStorageJson(RESPONSE_SESSION_NAMESPACE, candidate.key),
      deleteStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, candidate.key),
    ]),
  );
};

export const isPgResponseSessionStore = (): boolean => {
  return getStorageBackendMeta().backend === 'pg';
};

export const getResponseSession = async (
  id: string,
): Promise<ResponseSession | undefined> => {
  if (isPgResponseSessionStore()) {
    const session = await readStorageJson<ResponseSession>(
      RESPONSE_SESSION_NAMESPACE,
      id,
    );
    if (!session || session.createdAt <= Date.now() - RESPONSE_SESSION_TTL_MS) {
      if (session) {
        await deleteStorageJson(RESPONSE_SESSION_NAMESPACE, id);
        await deleteStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, id);
      }
      return undefined;
    }
    return session;
  }

  pruneResponseSessions();
  return getSessionStore().get(id);
};

export const getValidatedPreviousSession = async (
  previousResponseId: string | null,
  accessKeyId: string | null,
): Promise<ResponseSession | undefined> => {
  const previousSession = previousResponseId
    ? await getResponseSession(previousResponseId)
    : undefined;

  if (
    previousResponseId &&
    (!previousSession || previousSession.accessKeyId !== accessKeyId)
  ) {
    throw new Error('Unknown or expired previous_response_id');
  }

  return previousSession;
};

export const storeResponseSession = async (
  session: ResponseSession,
): Promise<void> => {
  const serialized = JSON.stringify(session);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_SESSION_BYTES) {
    throw new Error('Response session exceeds the maximum size');
  }

  if (isPgResponseSessionStore()) {
    await writeStorageJson(RESPONSE_SESSION_NAMESPACE, session.id, session);
    await writeStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, session.id, {
      bytes: Buffer.byteLength(serialized, 'utf8'),
      createdAt: session.createdAt,
    });
    try {
      await prunePgResponseSessions();
    } catch (error) {
      console.warn('[CodeBuddy2API] Unable to prune Responses sessions', error);
    }
    return;
  }

  const store = getSessionStore();
  const byteStore = getSessionByteStore();
  const previousBytes = byteStore.get(session.id) ?? 0;
  const sessionBytes = Buffer.byteLength(serialized, 'utf8');
  store.set(session.id, session);
  byteStore.set(session.id, sessionBytes);
  setSessionTotalBytes(getSessionTotalBytes() - previousBytes + sessionBytes);
  pruneResponseSessions();
};

export const storeUpstreamResponseBinding = async ({
  model,
  proxyContext,
  responseId,
}: {
  model: string;
  proxyContext: ProxyContext;
  responseId: string;
}): Promise<void> => {
  await storeResponseSession({
    accessKeyId: proxyContext.accessKeyId,
    credentialFilename: proxyContext.credentialFilename,
    createdAt: Date.now(),
    defaults: {},
    id: responseId,
    model,
    transcript: [],
    upstreamProtocol: 'responses',
  });
};

export const resetResponseSessions = (): void => {
  getSessionStore().clear();
  getSessionByteStore().clear();
  setSessionTotalBytes(0);
};
