/**
 * The version of the deployment serving the console.
 *
 * Only worth asking a backend that is not the app: the gateway the app starts
 * is the app, so its version is the one the menu bar already names. A remote
 * deployment is a build of its own and can be ahead of or behind the app, which
 * is exactly what makes the number worth a row in the menu.
 */
import { authHeaders } from './request-headers';

const VERSION_TIMEOUT_MS = 5_000;

/** Null for a payload that is not one: no version is better than a wrong one. */
export const serverVersionFromPayload = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const version = (payload as { version?: unknown }).version;

  return typeof version === 'string' && version.trim() ? version.trim() : null;
};

export const fetchServerVersion = async ({
  baseUrl,
  cookie = '',
  signal = AbortSignal.timeout(VERSION_TIMEOUT_MS),
  token = '',
}: {
  baseUrl: string;
  cookie?: string;
  signal?: AbortSignal;
  /** The token a deployment handed this app, when the version is a deployment's. */
  token?: string;
}): Promise<string | null> => {
  try {
    const response = await fetch(`${baseUrl}/admin-api/version`, {
      headers: authHeaders({ cookie, token }),
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return serverVersionFromPayload(await response.json());
  } catch {
    // An unreachable deployment, or one that wants a sign-in the shell has no
    // cookie for: the row then simply is not shown.
    return null;
  }
};
