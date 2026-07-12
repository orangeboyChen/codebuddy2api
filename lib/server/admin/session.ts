import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

import type { NextRequest } from 'next/server';
import {
  type AuthenticatorTransportFuture,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { readStorageJsonResult, writeStorageJson } from '../storage';

import { getActiveConfig } from '../domain/config';

const ADMIN_AUTH_NAMESPACE = 'admin-auth';
const ADMIN_AUTH_KEY = 'state';
const ADMIN_SESSION_COOKIE = 'codebuddy_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const ADMIN_RP_NAME = 'CodeBuddy2API Admin';
const ADMIN_USER_ID = 'codebuddy-admin';
const DEFAULT_ADMIN_USER_NAME = 'admin';
let adminAuthMutationQueue: Promise<void> = Promise.resolve();

type RequestLike = Request | NextRequest;

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
}

interface StoredPasskeyRecord {
  backedUp?: boolean;
  counter: number;
  createdAt: string;
  deviceType?: string;
  id: string;
  name: string;
  publicKey: string;
  transports?: AuthenticatorTransportFuture[];
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

const createPasswordHash = (password: string, salt?: string) => {
  const resolvedSalt = salt ?? randomBytes(16).toString('hex');
  const hash = scryptSync(password, resolvedSalt, 64).toString('hex');

  return {
    hash,
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

const verifyPasswordHash = (
  password: string,
  stored: StoredPasswordRecord | null,
): boolean => {
  if (!stored) {
    return false;
  }

  const candidate = createPasswordHash(password, stored.salt);
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
      return decodeURIComponent(rest.join('='));
    }
  }

  return null;
};

const getRequestProtocol = (request: RequestLike): string => {
  return (
    request.headers.get('x-forwarded-proto') ??
    new URL(request.url).protocol.replace(':', '') ??
    'http'
  );
};

const getRequestHost = (request: RequestLike): string => {
  return (
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    new URL(request.url).host
  );
};

const getRequestHostname = (request: RequestLike): string => {
  return getRequestHost(request).replace(/:\d+$/, '');
};

const buildCookieString = (
  request: RequestLike,
  value: string,
  maxAgeSeconds: number,
): string => {
  const secure = getRequestProtocol(request) === 'https';

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

const attachSessionCookie = (
  request: RequestLike,
  response: Response,
  token: string,
): Response => {
  response.headers.set(
    'Set-Cookie',
    buildCookieString(request, token, ADMIN_SESSION_TTL_SECONDS),
  );
  return response;
};

const attachLogoutCookie = (
  request: RequestLike,
  response: Response,
): Response => {
  response.headers.set('Set-Cookie', buildCookieString(request, '', 0));
  return response;
};

const getSessionToken = (request: RequestLike): string | null => {
  return getCookieValue(request, ADMIN_SESSION_COOKIE);
};

const getValidSessionRecord = (
  request: RequestLike,
): Promise<StoredSessionRecord | null> => {
  const token = getSessionToken(request);

  if (!token) {
    return Promise.resolve(null);
  }

  const tokenHash = hashSessionToken(token);
  return mutateAdminAuthState((state) => {
    let matched: StoredSessionRecord | null = null;
    matched =
      state.sessions.find((entry) => {
        return entry.tokenHash === tokenHash;
      }) ?? null;

    if (matched) {
      matched.lastUsedAt = new Date().toISOString();
    }
    return matched;
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

const getWebAuthnOrigin = (request: RequestLike): string => {
  return `${getRequestProtocol(request)}://${getRequestHost(request)}`;
};

const getWebAuthnRpId = async (request: RequestLike): Promise<string> => {
  const config = await getActiveConfig();
  const configured = String(
    (config as unknown as Record<string, unknown>)
      .CODEBUDDY_ADMIN_PASSKEY_RP_ID ?? '',
  ).trim();

  if (configured) {
    return configured;
  }

  return getRequestHostname(request);
};

const canRegisterAdminPasskeys = (request: RequestLike): boolean => {
  const hostname = getRequestHostname(request).toLowerCase();

  return (
    getRequestProtocol(request) === 'https' ||
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

export const hasAdminAccount = (): boolean => {
  throw new Error('Use hasAdminAccountAsync');
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

  return {
    accountConfigured:
      state.enabled && (Boolean(state.password) || state.passkeys.length > 0),
    authEnabled: state.enabled,
    authenticated: await isAdminSessionAuthenticated(request),
    passkeyCount: state.passkeys.length,
    passwordConfigured: Boolean(state.password),
    username: state.username,
  };
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

  const nextPassword = createPasswordHash(normalized);
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
    state.sessions.push(session);
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

export const loginWithAdminPassword = async (
  request: RequestLike,
  usernameOrPassword: string,
  password?: string,
): Promise<Response> => {
  const username =
    password === undefined ? DEFAULT_ADMIN_USER_NAME : usernameOrPassword;
  const resolvedPassword = password ?? usernameOrPassword;
  const state = pruneExpiredState(await loadAdminAuthStateAsync());

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
    !verifyPasswordHash(resolvedPassword, state.password)
  ) {
    return Response.json(
      {
        error: {
          message: 'Invalid password',
        },
      },
      { status: 401 },
    );
  }

  const { session, token } = createAdminSession();

  await mutateAdminAuthState((current) => {
    current.sessions.push(session);
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
        passwordConfigured: true,
        username: state.username,
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
  const nextPasswordHash = createPasswordHash(normalizedNextPassword);
  const updated = await mutateAdminAuthState((state) => {
    if (
      state.password &&
      !verifyPasswordHash(currentPassword, state.password)
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

  if (!canRegisterAdminPasskeys(request)) {
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

  if (!canRegisterAdminPasskeys(request)) {
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
      expectedOrigin: getWebAuthnOrigin(request),
      expectedRPID: await getWebAuthnRpId(request),
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
      expectedOrigin: getWebAuthnOrigin(request),
      expectedRPID: await getWebAuthnRpId(request),
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
    current.sessions.push(session);
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
