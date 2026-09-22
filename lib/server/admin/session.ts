import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { NextRequest } from 'next/server';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { readStorageJsonResult, writeStorageJson } from '../storage';
import { getForwardedHeaderValue } from '../shared/http';

import { getActiveConfig } from '../domain/config';
import type { UsageRange } from '../domain/usage';

const ADMIN_AUTH_NAMESPACE = 'admin-auth';
const ADMIN_AUTH_KEY = 'state';
const ADMIN_SESSION_COOKIE = 'codebuddy_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const ADMIN_RP_NAME = 'CodeBuddy2API Admin';
const ADMIN_USER_ID = 'codebuddy-admin';
const DEFAULT_ADMIN_USER_NAME = 'admin';
/**
 * How stale `lastUsedAt` may be before a request refreshes it. Touching the
 * stored session on every single request would rewrite the whole admin
 * document constantly, which loses concurrent writes when several instances
 * share one database; a minute of slack still tells an idle session from an
 * active one.
 */
const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;
/** Ceiling on stored sessions, so repeated sign-ins cannot grow the document
 * without bound: past it the oldest sessions are dropped. */
const MAX_ADMIN_SESSIONS = 50;
/** Key length every stored password hash was derived with. Part of the stored
 * format, so it must not change. */
const PASSWORD_HASH_KEY_LENGTH = 64;
/** Failed sign-ins allowed for one username before throttling. */
const ADMIN_LOGIN_MAX_FAILURES = 10;
/** Ceiling on tracked buckets, so sprayed usernames cannot grow the map. */
const ADMIN_LOGIN_THROTTLE_MAX_KEYS = 10_000;
const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';
const FORWARDED_HOST_HEADER = 'x-forwarded-host';
let adminAuthMutationQueue: Promise<void> = Promise.resolve();

type RequestLike = Request | NextRequest;

interface AdminLoginThrottle {
  failures: number;
  firstFailureAt: number;
}

/**
 * Failed sign-in counters live on `globalThis` so they survive the module
 * reloads a dev server performs; a lockout that reset on reload would not slow
 * an attacker down at all.
 */
const globalAdminLoginState = globalThis as typeof globalThis & {
  __codebuddy2apiAdminLoginThrottle__?: Map<string, AdminLoginThrottle>;
};

interface StoredPasswordRecord {
  hash: string;
  salt: string;
  updatedAt: string;
}

interface StoredSessionRecord {
  createdAt: string;
  expiresAt: string;
  id: string;
  lastUsedAt: string;
  tokenHash: string;
  usagePreferences?: AdminUsagePreferences;
}

export interface AdminUsagePreferences {
  accessKey: string[];
  autoRefreshSeconds: number;
  credential: string[];
  range: UsageRange;
}

interface StoredPasskeyRecord {
  backedUp?: boolean;
  counter: number;
  createdAt: string;
  deviceType?: string;
  id: string;
  name: string;
  publicKey: string;
  transports?: string[];
}

interface PendingChallengeRecord {
  challenge: string;
  createdAt: string;
  expiresAt: string;
  type: 'authentication' | 'registration';
}

interface AdminAuthState {
  enabled: boolean;
  passkeys: StoredPasskeyRecord[];
  password: StoredPasswordRecord | null;
  pendingChallenges: PendingChallengeRecord[];
  sessions: StoredSessionRecord[];
  username: string;
}

class AdminAuthStorageError extends Error {}

const enqueueAdminAuthMutation = async <T>(
  mutation: () => Promise<T>,
): Promise<T> => {
  const operation = adminAuthMutationQueue.then(mutation, mutation);
  adminAuthMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

const getEmptyAdminAuthState = (): AdminAuthState => {
  return {
    enabled: false,
    passkeys: [],
    password: null,
    pendingChallenges: [],
    sessions: [],
    username: DEFAULT_ADMIN_USER_NAME,
  };
};

const isAdminAuthStateDocument = (value: unknown): boolean => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const normalizeAdminAuthState = (input: unknown): AdminAuthState => {
  if (!input || typeof input !== 'object') {
    return getEmptyAdminAuthState();
  }

  const record = input as Partial<AdminAuthState>;

  const hasLegacyAuthenticator =
    Boolean(record.password) ||
    (Array.isArray(record.passkeys) && record.passkeys.length > 0);

  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : hasLegacyAuthenticator,
    passkeys: Array.isArray(record.passkeys) ? record.passkeys : [],
    password:
      record.password && typeof record.password === 'object'
        ? record.password
        : null,
    pendingChallenges: Array.isArray(record.pendingChallenges)
      ? record.pendingChallenges
      : [],
    sessions: Array.isArray(record.sessions) ? record.sessions : [],
    username:
      typeof record.username === 'string' && record.username.trim()
        ? record.username.trim()
        : DEFAULT_ADMIN_USER_NAME,
  };
};

const loadAdminAuthStateAsync = async (): Promise<AdminAuthState> => {
  const result = await readStorageJsonResult<AdminAuthState>(
    ADMIN_AUTH_NAMESPACE,
    ADMIN_AUTH_KEY,
  );

  if (
    result.error ||
    (result.exists && !isAdminAuthStateDocument(result.value))
  ) {
    throw new AdminAuthStorageError(
      result.error ?? 'Admin authentication document has an invalid shape',
    );
  }

  return normalizeAdminAuthState(result.value);
};

const saveAdminAuthState = async (state: AdminAuthState): Promise<void> => {
  await writeStorageJson(ADMIN_AUTH_NAMESPACE, ADMIN_AUTH_KEY, state);
};

/**
 * scrypt off the event loop.
 *
 * The cost, block size and parallelization stay at Node's defaults and the key
 * length stays at 64 bytes because those parameters are part of every stored
 * hash: changing any of them would invalidate existing admin passwords. Only
 * the blocking call is replaced, and it produces byte-identical output.
 */
const scryptAsync = (
  password: string,
  salt: string,
  keyLength: number,
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
};

const createPasswordHash = async (
  password: string,
  salt?: string,
): Promise<{ hash: string; salt: string }> => {
  const resolvedSalt = salt ?? randomBytes(16).toString('hex');
  const derived = await scryptAsync(
    password,
    resolvedSalt,
    PASSWORD_HASH_KEY_LENGTH,
  );

  return {
    hash: derived.toString('hex'),
    salt: resolvedSalt,
  };
};

const normalizeUsername = (username: string): string | null => {
  const normalized = username.trim();

  if (normalized.length < 3 || normalized.length > 64) {
    return null;
  }

  return normalized;
};

const verifyPasswordHash = async (
  password: string,
  stored: StoredPasswordRecord | null,
): Promise<boolean> => {
  if (!stored) {
    return false;
  }

  const candidate = await createPasswordHash(password, stored.salt);
  const storedBuffer = Buffer.from(stored.hash, 'hex');
  const candidateBuffer = Buffer.from(candidate.hash, 'hex');

  if (storedBuffer.length !== candidateBuffer.length) {
    return false;
  }

  return timingSafeEqual(storedBuffer, candidateBuffer);
};

const hashSessionToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};

const getCookieValue = (request: RequestLike, name: string): string | null => {
  if ('cookies' in request && typeof request.cookies.get === 'function') {
    return request.cookies.get(name)?.value ?? null;
  }

  const cookieHeader = request.headers.get('cookie');

  if (!cookieHeader) {
    return null;
  }

  const pieces = cookieHeader.split(';');

  for (const piece of pieces) {
    const [rawName, ...rest] = piece.trim().split('=');

    if (rawName === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        // A malformed percent-escape is a broken cookie, not a broken request:
        // it must not take the whole page down for whoever sent it.
        return rest.join('=');
      }
    }
  }

  return null;
};

/**
 * Whether `X-Forwarded-*` headers may be trusted.
 *
 * Most deployments sit behind a reverse proxy that terminates TLS, so trusting
 * them stays the default: read the wrong way, the admin session cookie loses
 * `Secure` and WebAuthn rejects its own origin. Turning the flag off is the
 * opt-in for a directly exposed server, where those headers are client
 * controlled and must not decide the origin.
 */
const isForwardedHeadersTrusted = async (): Promise<boolean> => {
  const config = await getActiveConfig();

  return config.CODEBUDDY_ADMIN_TRUST_PROXY;
};

/**
 * The leftmost value of a comma-separated forwarded header.
 *
 * Every proxy hop appends, so `X-Forwarded-Proto: https, http` is a normal
 * value and comparing the whole header to `https` fails — the first entry is
 * the one the original client sent.
 */
const resolveRequestProtocol = (
  request: RequestLike,
  trustForwardedHeaders: boolean,
): string => {
  if (trustForwardedHeaders) {
    const forwarded = getForwardedHeaderValue(
      request.headers,
      FORWARDED_PROTO_HEADER,
    );

    if (forwarded) {
      return forwarded.toLowerCase();
    }
  }

  return new URL(request.url).protocol.replace(':', '');
};

const resolveRequestHost = (
  request: RequestLike,
  trustForwardedHeaders: boolean,
): string => {
  if (trustForwardedHeaders) {
    const forwarded = getForwardedHeaderValue(
      request.headers,
      FORWARDED_HOST_HEADER,
    );

    if (forwarded) {
      return forwarded;
    }

    const host = request.headers.get('host')?.trim();

    if (host) {
      return host;
    }
  }

  return new URL(request.url).host;
};

const resolveRequestHostname = (
  request: RequestLike,
  trustForwardedHeaders: boolean,
): string => {
  return resolveRequestHost(request, trustForwardedHeaders).replace(
    /:\d+$/,
    '',
  );
};

const buildCookieString = async (
  request: RequestLike,
  value: string,
  maxAgeSeconds: number,
): Promise<string> => {
  const secure =
    resolveRequestProtocol(request, await isForwardedHeadersTrusted()) ===
    'https';

  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
};

const pruneExpiredState = (state: AdminAuthState): AdminAuthState => {
  const now = Date.now();

  return {
    ...state,
    pendingChallenges: state.pendingChallenges.filter((entry) => {
      return new Date(entry.expiresAt).getTime() > now;
    }),
    sessions: state.sessions.filter((entry) => {
      return new Date(entry.expiresAt).getTime() > now;
    }),
  };
};

const mutateAdminAuthState = async <T>(
  mutator: (state: AdminAuthState) => T | Promise<T>,
): Promise<T> => {
  return enqueueAdminAuthMutation(async () => {
    const state = pruneExpiredState(await loadAdminAuthStateAsync());
    const result = await mutator(state);
    await saveAdminAuthState(state);
    return result;
  });
};

const createAdminSession = () => {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  const session: StoredSessionRecord = {
    createdAt: now.toISOString(),
    expiresAt,
    id: randomBytes(12).toString('hex'),
    lastUsedAt: now.toISOString(),
    tokenHash: hashSessionToken(token),
  };

  return {
    session,
    token,
  };
};

const attachSessionCookie = async (
  request: RequestLike,
  response: Response,
  token: string,
): Promise<Response> => {
  response.headers.set(
    'Set-Cookie',
    await buildCookieString(request, token, ADMIN_SESSION_TTL_SECONDS),
  );
  return response;
};

const attachLogoutCookie = async (
  request: RequestLike,
  response: Response,
): Promise<Response> => {
  response.headers.set('Set-Cookie', await buildCookieString(request, '', 0));
  return response;
};

const getSessionToken = (request: RequestLike): string | null => {
  return getCookieValue(request, ADMIN_SESSION_COOKIE);
};

const usageRanges = new Set<UsageRange>([
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
  'today',
  'yesterday',
]);
const usageAutoRefreshSeconds = new Set([0, 5, 15, 30, 60, 300]);

const normalizeUsagePreferenceValues = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 100);
};

const normalizeUsagePreferences = (
  value: unknown,
): AdminUsagePreferences | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<AdminUsagePreferences>;

  if (!usageRanges.has(record.range as UsageRange)) {
    return null;
  }

  const autoRefreshSeconds = Number(record.autoRefreshSeconds);

  if (!usageAutoRefreshSeconds.has(autoRefreshSeconds)) {
    return null;
  }

  return {
    accessKey: normalizeUsagePreferenceValues(record.accessKey),
    autoRefreshSeconds,
    credential: normalizeUsagePreferenceValues(record.credential),
    range: record.range as UsageRange,
  };
};

const findSessionByTokenHash = (
  state: AdminAuthState,
  tokenHash: string,
): StoredSessionRecord | null => {
  return (
    state.sessions.find((entry) => {
      return entry.tokenHash === tokenHash;
    }) ?? null
  );
};

/**
 * Adds a session and drops the oldest ones when the cap is exceeded.
 *
 * Sessions are only pruned when they expire, so repeated sign-ins would
 * otherwise grow the stored document without limit; keeping the newest
 * `MAX_ADMIN_SESSIONS` bounds it while leaving the current sign-in in place.
 */
const appendAdminSession = (
  state: AdminAuthState,
  session: StoredSessionRecord,
): void => {
  state.sessions.push(session);

  if (state.sessions.length <= MAX_ADMIN_SESSIONS) {
    return;
  }

  // The session being appended is never a candidate for eviction. Instances
  // sharing one database do not share a clock: a new session stamped by a
  // lagging instance can sort oldest and would be dropped, handing back a
  // cookie for a session that was never stored.
  const previous = state.sessions.slice(0, -1);
  const keep = MAX_ADMIN_SESSIONS - 1;

  state.sessions = [
    ...previous
      .slice()
      .sort((left, right) => {
        return (
          new Date(left.createdAt).getTime() -
          new Date(right.createdAt).getTime()
        );
      })
      .slice(Math.max(0, previous.length - keep)),
    session,
  ];
};

const getValidSessionRecord = async (
  request: RequestLike,
): Promise<StoredSessionRecord | null> => {
  const token = getSessionToken(request);

  if (!token) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  const matched = findSessionByTokenHash(state, tokenHash);

  if (!matched) {
    return null;
  }

  // Recognising a session needs no write, and rewriting the whole document on
  // every admin request loses concurrent updates when the storage is shared.
  // Only a `lastUsedAt` older than the touch interval is refreshed.
  const lastUsedAt = new Date(matched.lastUsedAt).getTime();

  if (
    Number.isFinite(lastUsedAt) &&
    Date.now() - lastUsedAt < ADMIN_SESSION_TOUCH_INTERVAL_MS
  ) {
    return matched;
  }

  return mutateAdminAuthState((current) => {
    const target = findSessionByTokenHash(current, tokenHash);

    if (target) {
      target.lastUsedAt = new Date().toISOString();
    }

    return target;
  });
};

const clearChallengeType = (
  state: AdminAuthState,
  type: PendingChallengeRecord['type'],
): void => {
  state.pendingChallenges = state.pendingChallenges.filter((entry) => {
    return entry.type !== type;
  });
};

const setPendingChallenge = (
  type: PendingChallengeRecord['type'],
  challenge: string,
): Promise<void> => {
  return mutateAdminAuthState((state) => {
    clearChallengeType(state, type);
    state.pendingChallenges.push({
      challenge,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS).toISOString(),
      type,
    });
  });
};

const consumePendingChallenge = async (
  type: PendingChallengeRecord['type'],
): Promise<string | null> => {
  return mutateAdminAuthState((state) => {
    let challenge: string | null = null;
    const match = state.pendingChallenges.find((entry) => entry.type === type);

    if (!match) {
      return null;
    }

    challenge = match.challenge;
    clearChallengeType(state, type);
    return challenge;
  });
};

const getWebAuthnOrigin = async (request: RequestLike): Promise<string> => {
  const trustForwardedHeaders = await isForwardedHeadersTrusted();

  return `${resolveRequestProtocol(
    request,
    trustForwardedHeaders,
  )}://${resolveRequestHost(request, trustForwardedHeaders)}`;
};

const getWebAuthnRpId = async (request: RequestLike): Promise<string> => {
  const config = await getActiveConfig();
  const configured = config.CODEBUDDY_ADMIN_PASSKEY_RP_ID.trim();

  if (configured) {
    return configured;
  }

  return resolveRequestHostname(request, config.CODEBUDDY_ADMIN_TRUST_PROXY);
};

const canRegisterAdminPasskeys = async (
  request: RequestLike,
): Promise<boolean> => {
  const trustForwardedHeaders = await isForwardedHeadersTrusted();
  const hostname = resolveRequestHostname(
    request,
    trustForwardedHeaders,
  ).toLowerCase();

  return (
    resolveRequestProtocol(request, trustForwardedHeaders) === 'https' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
};

const getAdminPasskeyRegistrationError = async (
  request: RequestLike,
): Promise<Response | null> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  if (await isAdminSessionAuthenticated(request)) {
    return null;
  }

  return Response.json(
    {
      error: {
        code: 'admin_auth_required',
        message: 'Admin session required',
      },
    },
    { status: 401 },
  );
};

const getPasskeyDescriptor = (entry: StoredPasskeyRecord) => {
  return {
    id: entry.id,
    transports: entry.transports,
    type: 'public-key' as const,
  };
};

export const hasAdminAccountAsync = async (): Promise<boolean> => {
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  return (
    state.enabled && (Boolean(state.password) || state.passkeys.length > 0)
  );
};

export const hasAdminPassword = async (): Promise<boolean> => {
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  return Boolean(state.password);
};

export const listAdminPasskeys = async (): Promise<StoredPasskeyRecord[]> => {
  return pruneExpiredState(await loadAdminAuthStateAsync()).passkeys;
};

export const deleteAdminPasskey = async (
  request: RequestLike,
  id: string,
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  const result = await mutateAdminAuthState((state) => {
    const passkey = state.passkeys.find((entry) => entry.id === id);

    if (!passkey) {
      return 'missing';
    }

    if (!state.password && state.passkeys.length === 1) {
      return 'last-authenticator';
    }

    state.passkeys = state.passkeys.filter((entry) => entry.id !== id);
    return 'deleted';
  });

  if (result === 'missing') {
    return Response.json(
      { error: { message: 'Passkey not found' } },
      { status: 404 },
    );
  }

  if (result === 'last-authenticator') {
    return Response.json(
      {
        error: {
          message: 'Set an admin password before removing the last passkey',
        },
      },
      { status: 409 },
    );
  }

  return Response.json({ success: true });
};

export const isAdminSessionAuthenticated = async (
  request: RequestLike,
): Promise<boolean> => {
  return (await getValidSessionRecord(request)) !== null;
};

export const getAdminSessionSummary = async (request: RequestLike) => {
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  const session = await getValidSessionRecord(request);

  return {
    accountConfigured:
      state.enabled && (Boolean(state.password) || state.passkeys.length > 0),
    authEnabled: state.enabled,
    authenticated: session !== null,
    passkeyCount: state.passkeys.length,
    passwordConfigured: Boolean(state.password),
    username: state.username,
    usagePreferences: normalizeUsagePreferences(session?.usagePreferences),
  };
};

export const updateAdminSessionUsagePreferences = async (
  request: RequestLike,
  preferences: unknown,
): Promise<AdminUsagePreferences | null> => {
  const normalizedPreferences = normalizeUsagePreferences(preferences);
  const token = getSessionToken(request);

  if (!normalizedPreferences) {
    return null;
  }

  if (!token) {
    const state = pruneExpiredState(await loadAdminAuthStateAsync());
    return state.enabled ? null : normalizedPreferences;
  }

  const tokenHash = hashSessionToken(token);

  return mutateAdminAuthState((state) => {
    if (!state.enabled) {
      return normalizedPreferences;
    }

    const session = state.sessions.find(
      (entry) => entry.tokenHash === tokenHash,
    );

    if (!session) {
      return null;
    }

    session.usagePreferences = normalizedPreferences;
    session.lastUsedAt = new Date().toISOString();

    return normalizedPreferences;
  });
};

export const getAdminSessionErrorResponse = (
  request: RequestLike,
): Promise<Response | null> => {
  return (async () => {
    try {
      if (!(await hasAdminAccountAsync())) {
        return null;
      }

      if (await isAdminSessionAuthenticated(request)) {
        return null;
      }

      return Response.json(
        {
          error: {
            code: 'admin_auth_required',
            message: 'Admin session required',
          },
        },
        { status: 401 },
      );
    } catch (error) {
      if (error instanceof AdminAuthStorageError) {
        return Response.json(
          {
            error: {
              code: 'admin_auth_storage_unavailable',
              message: 'Admin authentication storage is unreadable',
            },
          },
          { status: 503 },
        );
      }

      throw error;
    }
  })();
};

export const setupAdminPassword = async (
  request: RequestLike,
  usernameOrPassword: string,
  password?: string,
): Promise<Response> => {
  const username =
    password === undefined ? DEFAULT_ADMIN_USER_NAME : usernameOrPassword;
  const resolvedPassword = password ?? usernameOrPassword;
  const normalized = resolvedPassword.trim();
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername) {
    return Response.json(
      { error: { message: 'Username must be between 3 and 64 characters' } },
      { status: 400 },
    );
  }

  if (normalized.length < PASSWORD_MIN_LENGTH) {
    return Response.json(
      {
        error: {
          message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        },
      },
      { status: 400 },
    );
  }

  // Checked before the password is hashed and before any write. This endpoint
  // has to stay open for first-run setup, so a completed deployment would
  // otherwise let any caller force a full read-modify-write of the auth
  // document — and a scrypt — on every request, and every one of those writes
  // can also undo a concurrent rotation by writing back its own stale snapshot.
  if (pruneExpiredState(await loadAdminAuthStateAsync()).enabled) {
    return Response.json(
      {
        error: {
          message: 'Admin account is already configured',
        },
      },
      { status: 409 },
    );
  }

  const nextPassword = await createPasswordHash(normalized);
  const { session, token } = createAdminSession();

  const configured = await mutateAdminAuthState((state) => {
    if (state.enabled) {
      return false;
    }

    state.enabled = true;
    state.password = {
      hash: nextPassword.hash,
      salt: nextPassword.salt,
      updatedAt: new Date().toISOString(),
    };
    state.username = normalizedUsername;
    appendAdminSession(state, session);
    return true;
  });

  if (!configured) {
    return Response.json(
      {
        error: {
          message: 'Admin account is already configured',
        },
      },
      { status: 409 },
    );
  }

  return attachSessionCookie(
    request,
    Response.json({
      success: true,
      session: {
        accountConfigured: true,
        authEnabled: true,
        authenticated: true,
        passkeyCount: 0,
        passwordConfigured: true,
        username: normalizedUsername,
      },
    }),
    token,
  );
};

/**
 * The bucket a failed sign-in is charged to.
 *
 * Deliberately keyed on the username alone. A client address is not usable
 * here: `X-Forwarded-For` is attacker-controlled whenever the request reached
 * us without a proxy we control, so charging failures to it lets a caller
 * mint a fresh budget per request and guess passwords without limit. The
 * username is the one part of the credential pair the caller cannot vary
 * without changing what it is attacking.
 *
 * The trade-off is that someone who knows the username can keep it locked out
 * of password sign-in. That is the same exposure a per-address limit has, minus
 * the bypass. The mitigation is to register a passkey: that path is separate and
 * stays available.
 */
const getLoginThrottleKey = (username: string): string => {
  // Hashed so the key has a fixed, short footprint: the username arrives from
  // an unauthenticated request body and is never length-checked on this path.
  return createHash('sha256')
    .update(username.trim().toLowerCase())
    .digest('hex');
};

const getAdminLoginThrottles = (): Map<string, AdminLoginThrottle> => {
  if (!globalAdminLoginState.__codebuddy2apiAdminLoginThrottle__) {
    globalAdminLoginState.__codebuddy2apiAdminLoginThrottle__ = new Map();
  }

  return globalAdminLoginState.__codebuddy2apiAdminLoginThrottle__;
};

const isAdminLoginThrottled = (key: string): boolean => {
  const throttles = getAdminLoginThrottles();
  const entry = throttles.get(key);

  if (!entry) {
    return false;
  }

  if (Date.now() - entry.firstFailureAt >= ADMIN_LOGIN_FAILURE_WINDOW_MS) {
    throttles.delete(key);
    return false;
  }

  return entry.failures >= ADMIN_LOGIN_MAX_FAILURES;
};

const recordAdminLoginFailure = (key: string): void => {
  const now = Date.now();
  const throttles = getAdminLoginThrottles();

  // Expired counters are swept on write so the map does not keep growing once
  // an attacker stops sending.
  for (const [entryKey, entry] of throttles) {
    if (now - entry.firstFailureAt >= ADMIN_LOGIN_FAILURE_WINDOW_MS) {
      throttles.delete(entryKey);
    }
  }

  // A caller can spray distinct usernames faster than entries expire, so the
  // map needs a hard ceiling as well: drop the oldest windows until it fits.
  if (throttles.size >= ADMIN_LOGIN_THROTTLE_MAX_KEYS && !throttles.has(key)) {
    const overflow = throttles.size - ADMIN_LOGIN_THROTTLE_MAX_KEYS + 1;
    let removed = 0;

    for (const entryKey of throttles.keys()) {
      if (removed >= overflow) {
        break;
      }

      throttles.delete(entryKey);
      removed += 1;
    }
  }

  const entry = throttles.get(key);

  if (!entry) {
    throttles.set(key, { failures: 1, firstFailureAt: now });
    return;
  }

  entry.failures += 1;
};

const clearAdminLoginFailures = (key: string): void => {
  getAdminLoginThrottles().delete(key);
};

export const loginWithAdminPassword = async (
  request: RequestLike,
  usernameOrPassword: string,
  password?: string,
): Promise<Response> => {
  const username =
    password === undefined ? DEFAULT_ADMIN_USER_NAME : usernameOrPassword;
  const resolvedPassword = password ?? usernameOrPassword;
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  const throttleKey = getLoginThrottleKey(username);

  // Checked before the password is hashed: once a username is over the limit,
  // further guesses cost nothing on our side either.
  if (isAdminLoginThrottled(throttleKey)) {
    return Response.json(
      {
        error: {
          code: 'admin_login_rate_limited',
          message: 'Too many failed sign-in attempts, try again later',
        },
      },
      { status: 429 },
    );
  }

  if (!state.enabled || !state.password) {
    return Response.json(
      {
        error: {
          message: 'Admin password is not configured',
        },
      },
      { status: 400 },
    );
  }

  if (
    username.trim() !== state.username ||
    !(await verifyPasswordHash(resolvedPassword, state.password))
  ) {
    recordAdminLoginFailure(throttleKey);

    return Response.json(
      {
        error: {
          message: 'Invalid password',
        },
      },
      { status: 401 },
    );
  }

  // The record the password was just verified against. The mutation below
  // refuses to mint a session if the stored record is no longer this one.
  const verified = state.password;
  const { session, token } = createAdminSession();

  // Re-checked inside the serialized mutation. scrypt yields, so a rotation
  // can land between the check above and here, and that rotation drops every
  // other session — a sign-in verified against the now stale snapshot must not
  // be allowed to mint one that outlives it.
  //
  // Compared by record rather than re-hashed on purpose: an await inside the
  // mutation stretches the gap between its read and its write, and across
  // instances that gap is a lost update that silently undoes the rotation.
  const accepted = await mutateAdminAuthState((current) => {
    if (!current.enabled || !current.password) {
      return false;
    }

    if (current.username !== username.trim()) {
      return false;
    }

    if (
      current.password.hash !== verified.hash ||
      current.password.salt !== verified.salt
    ) {
      return false;
    }

    appendAdminSession(current, session);

    return {
      passkeyCount: current.passkeys.length,
      username: current.username,
    };
  });

  if (!accepted) {
    // Only reachable when the rotation above landed mid-sign-in. The caller
    // presented the correct credential, so this is not a failure and must not
    // be counted against the throttle — otherwise enough near-misses with the
    // rotation would lock the admin out of their own fresh password.
    return Response.json(
      {
        error: {
          message: 'Credentials changed during sign-in, try again',
        },
      },
      { status: 401 },
    );
  }

  clearAdminLoginFailures(throttleKey);

  return attachSessionCookie(
    request,
    Response.json({
      success: true,
      session: {
        accountConfigured: true,
        authEnabled: true,
        authenticated: true,
        passkeyCount: accepted.passkeyCount,
        passwordConfigured: true,
        username: accepted.username,
      },
    }),
    token,
  );
};

export const changeAdminPassword = async (
  request: RequestLike,
  currentPassword: string,
  nextPassword: string,
  nextUsername?: string,
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  // `getAdminSessionErrorResponse` deliberately lets everything through before
  // an admin account exists, so that first-run setup is reachable. Rotation is
  // not: otherwise an unauthenticated caller could rewrite the password record
  // of a deployment that has not finished setup.
  if (!(await hasAdminAccountAsync())) {
    // 401 rather than 409: with no admin account there is no session to hold,
    // so from the caller's side this is simply "not authenticated", which is
    // also what this endpoint answered before.
    return Response.json(
      { error: { message: 'Admin session required' } },
      { status: 401 },
    );
  }

  const normalizedNextPassword = nextPassword.trim();
  const normalizedUsername = nextUsername
    ? normalizeUsername(nextUsername)
    : undefined;

  if (nextUsername && !normalizedUsername) {
    return Response.json(
      { error: { message: 'Username must be between 3 and 64 characters' } },
      { status: 400 },
    );
  }

  if (normalizedNextPassword.length < PASSWORD_MIN_LENGTH) {
    return Response.json(
      {
        error: {
          message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        },
      },
      { status: 400 },
    );
  }

  const sessionToken = getSessionToken(request);

  if (!sessionToken) {
    return Response.json(
      { error: { message: 'Admin session required' } },
      { status: 401 },
    );
  }

  const sessionTokenHash = hashSessionToken(sessionToken);
  const nextPasswordHash = await createPasswordHash(normalizedNextPassword);
  const currentState = pruneExpiredState(await loadAdminAuthStateAsync());

  // Verified outside the mutation, for the same reason the sign-in path does
  // it: an await inside the mutator widens the gap between its read and its
  // write, and across instances that gap silently undoes concurrent changes.
  if (
    currentState.password &&
    !(await verifyPasswordHash(currentPassword, currentState.password))
  ) {
    return Response.json(
      { error: { message: 'Current password is invalid' } },
      { status: 401 },
    );
  }

  const verified = currentState.password;
  const updated = await mutateAdminAuthState((state) => {
    // Refuse if the stored record is no longer the one just verified: a
    // concurrent rotation would otherwise be overwritten by this snapshot.
    if (
      Boolean(state.password) !== Boolean(verified) ||
      (state.password &&
        verified &&
        (state.password.hash !== verified.hash ||
          state.password.salt !== verified.salt))
    ) {
      return false;
    }

    state.password = {
      hash: nextPasswordHash.hash,
      salt: nextPasswordHash.salt,
      updatedAt: new Date().toISOString(),
    };
    if (normalizedUsername) {
      state.username = normalizedUsername;
    }
    state.sessions = state.sessions.filter((entry) => {
      return entry.tokenHash === sessionTokenHash;
    });
    return true;
  });

  if (!updated) {
    return Response.json(
      { error: { message: 'Current password is invalid' } },
      { status: 401 },
    );
  }

  return Response.json({ success: true });
};

export const disableAdminAuthentication = async (
  request: RequestLike,
): Promise<Response> => {
  const authError = await getAdminSessionErrorResponse(request);

  if (authError) {
    return authError;
  }

  await mutateAdminAuthState((state) => {
    state.enabled = false;
    state.passkeys = [];
    state.password = null;
    state.pendingChallenges = [];
    state.sessions = [];
    state.username = DEFAULT_ADMIN_USER_NAME;
  });

  return attachLogoutCookie(request, Response.json({ success: true }));
};

export const logoutAdminSession = async (
  request: RequestLike,
): Promise<Response> => {
  const token = getSessionToken(request);

  if (token) {
    const tokenHash = hashSessionToken(token);

    await mutateAdminAuthState((state) => {
      state.sessions = state.sessions.filter((entry) => {
        return entry.tokenHash !== tokenHash;
      });
    });
  }

  return attachLogoutCookie(
    request,
    Response.json({
      success: true,
    }),
  );
};

export const beginAdminPasskeyRegistration = async (
  request: RequestLike,
  name: string,
): Promise<Response> => {
  const authError = await getAdminPasskeyRegistrationError(request);

  if (authError) {
    return authError;
  }

  if (!(await canRegisterAdminPasskeys(request))) {
    return Response.json(
      {
        error: {
          message: 'Passkeys require HTTPS or a localhost origin',
        },
      },
      { status: 400 },
    );
  }

  const passkeys = await listAdminPasskeys();
  const trimmedName = name.trim() || `Passkey ${passkeys.length + 1}`;
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  const options = await generateRegistrationOptions({
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: state.passkeys.map(getPasskeyDescriptor),
    rpID: await getWebAuthnRpId(request),
    rpName: ADMIN_RP_NAME,
    userDisplayName: trimmedName,
    userID: new TextEncoder().encode(ADMIN_USER_ID),
    userName: state.username,
  });

  await setPendingChallenge('registration', options.challenge);

  return Response.json({
    name: trimmedName,
    options,
  });
};

export const finishAdminPasskeyRegistration = async (
  request: RequestLike,
  responseBody: Record<string, unknown>,
  name: string,
): Promise<Response> => {
  const authError = await getAdminPasskeyRegistrationError(request);

  if (authError) {
    return authError;
  }

  if (!(await canRegisterAdminPasskeys(request))) {
    return Response.json(
      {
        error: {
          message: 'Passkeys require HTTPS or a localhost origin',
        },
      },
      { status: 400 },
    );
  }

  const expectedChallenge = await consumePendingChallenge('registration');

  if (!expectedChallenge) {
    return Response.json(
      {
        error: {
          message: 'Registration challenge has expired',
        },
      },
      { status: 400 },
    );
  }

  let verification;

  try {
    verification = await verifyRegistrationResponse({
      expectedChallenge,
      expectedOrigin: await getWebAuthnOrigin(request),
      expectedRPID: await getWebAuthnRpId(request),
      requireUserVerification: false,
      response: responseBody as unknown as RegistrationResponseJSON,
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          message:
            error instanceof Error
              ? error.message
              : 'Passkey registration failed',
        },
      },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return Response.json(
      {
        error: {
          message: 'Passkey registration could not be verified',
        },
      },
      { status: 400 },
    );
  }

  const credential = verification.registrationInfo.credential;
  const id = credential.id;

  await mutateAdminAuthState((state) => {
    state.passkeys = state.passkeys.filter((entry) => entry.id !== id);
    state.passkeys.push({
      backedUp: verification.registrationInfo.credentialBackedUp,
      counter: credential.counter,
      createdAt: new Date().toISOString(),
      deviceType: verification.registrationInfo.credentialDeviceType,
      id,
      name: name.trim() || `Passkey ${state.passkeys.length + 1}`,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      transports: credential.transports ?? undefined,
    });
  });

  return Response.json({
    passkeys: await listAdminPasskeys(),
    success: true,
  });
};

export const beginAdminPasskeyAuthentication = async (
  request: RequestLike,
): Promise<Response> => {
  const state = pruneExpiredState(await loadAdminAuthStateAsync());

  if (!state.enabled || !state.passkeys.length) {
    return Response.json(
      {
        error: {
          message: 'No passkeys are configured',
        },
      },
      { status: 400 },
    );
  }

  const options = await generateAuthenticationOptions({
    allowCredentials: state.passkeys.map(getPasskeyDescriptor),
    rpID: await getWebAuthnRpId(request),
    userVerification: 'preferred',
  });

  await setPendingChallenge('authentication', options.challenge);

  return Response.json({ options });
};

export const finishAdminPasskeyAuthentication = async (
  request: RequestLike,
  responseBody: Record<string, unknown>,
): Promise<Response> => {
  const state = pruneExpiredState(await loadAdminAuthStateAsync());
  if (!state.enabled) {
    return Response.json(
      { error: { message: 'Admin authentication is disabled' } },
      { status: 400 },
    );
  }

  const credentialId =
    typeof responseBody.id === 'string' ? responseBody.id : undefined;
  const passkey = state.passkeys.find((entry) => entry.id === credentialId);

  if (!passkey) {
    return Response.json(
      {
        error: {
          message: 'Unknown passkey',
        },
      },
      { status: 400 },
    );
  }

  const expectedChallenge = await consumePendingChallenge('authentication');

  if (!expectedChallenge) {
    return Response.json(
      {
        error: {
          message: 'Authentication challenge has expired',
        },
      },
      { status: 400 },
    );
  }

  let verification;

  try {
    verification = await verifyAuthenticationResponse({
      credential: {
        counter: passkey.counter,
        id: passkey.id,
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        transports: passkey.transports,
      },
      expectedChallenge,
      expectedOrigin: await getWebAuthnOrigin(request),
      expectedRPID: await getWebAuthnRpId(request),
      requireUserVerification: false,
      response: responseBody as unknown as AuthenticationResponseJSON,
    });
  } catch (error) {
    return Response.json(
      {
        error: {
          message:
            error instanceof Error
              ? error.message
              : 'Passkey authentication failed',
        },
      },
      { status: 400 },
    );
  }

  if (!verification.verified) {
    return Response.json(
      {
        error: {
          message: 'Passkey authentication could not be verified',
        },
      },
      { status: 401 },
    );
  }

  const { session, token } = createAdminSession();

  await mutateAdminAuthState((current) => {
    appendAdminSession(current, session);
    current.passkeys = current.passkeys.map((entry) => {
      if (entry.id !== passkey.id) {
        return entry;
      }

      return {
        ...entry,
        counter: verification.authenticationInfo.newCounter,
      };
    });
  });

  return attachSessionCookie(
    request,
    Response.json({
      success: true,
      session: {
        accountConfigured: true,
        authEnabled: true,
        authenticated: true,
        passkeyCount: state.passkeys.length,
        passwordConfigured: Boolean(state.password),
        username: state.username,
      },
    }),
    token,
  );
};
