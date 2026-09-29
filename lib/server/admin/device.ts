/**
 * Signing a device in without typing the password into it.
 *
 * The desktop app renders its own console from `127.0.0.1`, which is what keeps
 * a deployment's pages out of the app's window — and is also why a passkey saved
 * for that deployment cannot be used there: a browser offers a credential to the
 * origin it is on, and a passkey is bound to the deployment's address besides.
 * The device authorization grant is the way out of that: the app asks for a code
 * here, the user approves it in a browser on the deployment's own page — where
 * the passkey and the saved passwords do work — and the app is handed a token.
 *
 * So the shapes are the ones RFC 8628 names, because they are the ones a client
 * that has no secret to keep can use: a `device_code` the client polls with, a
 * `user_code` a person reads off one screen and types into another, and a token
 * that only ever goes to the client that asked, over a connection the user
 * approved by hand.
 *
 * What is stored here is the grant and the token, never the codes themselves —
 * the same reason a session is stored as a hash: a read of this document must
 * not be enough to use what it describes. Even the code the user types is kept
 * as a hash, so that a read of the file is not a way to approve a grant nobody
 * approved.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { readStorageJsonResult, writeStorageJson } from '../storage';

import {
  DEVICE_CLIENT_ID,
  DEVICE_GRANT_TYPE,
  DEVICE_VERIFICATION_PATH,
} from './device-client';

const DEVICE_NAMESPACE = 'admin-device';
const DEVICE_KEY = 'grants';

const DEVICE_CODE_BYTES = 32;
const ACCESS_TOKEN_BYTES = 32;

/**
 * What a user code is drawn from: digits and letters that are not one another
 * in another typeface. `1`, `0`, `I`, `O`, `L` and `U` are left out, which is
 * what makes a code someone read off a dialog land in a box unharmed.
 */
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Groups a code is broken into, so it can be read four characters at a time. */
const USER_CODE_GROUP_LENGTH = 4;
const USER_CODE_GROUPS = 2;

/**
 * How long the user has to approve: long enough to open a browser, sign in and
 * read a code off another screen, short enough that a code left on one is not
 * still good hours later.
 */
const GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * How long the token the device is handed stays good.
 *
 * Longer than a session, because it is the one that has to survive the app
 * being closed and opened again days later: a device that had to be approved
 * every eight hours would be a device nobody approved twice.
 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often a device is told to ask again while it waits. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** Ceiling and floor on the interval a client hands out, so neither a device
 * that hammers this console nor one that never asks again can be arranged. */
export const MIN_POLL_INTERVAL_SECONDS = 1;
const MAX_POLL_INTERVAL_SECONDS = 30;

/** Ceilings on what is stored, so a grant asked for in a loop cannot grow the
 * document without bound. Past them, the oldest go. */
const MAX_GRANTS = 200;
const MAX_TOKENS = 50;

export type DeviceGrantError =
  'authorization_pending' | 'expired_token' | 'invalid_grant' | 'slow_down';

export interface DeviceAuthorization {
  device_code: string;
  expires_in: number;
  interval: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
}

export interface DeviceTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

interface StoredGrant {
  clientId: string;
  /**
   * Where the browser is sent once the user has approved, when the device asked
   * for one: a loopback address of its own, which is the only place a token can
   * be handed to it without a secret to keep.
   */
  redirectUri?: string;
  createdAt: string;
  deviceCodeHash: string;
  expiresAt: string;
  status: 'approved' | 'pending';
  userCodeHash: string;
}

interface StoredDeviceToken {
  clientId: string;
  createdAt: string;
  expiresAt: string;
  id: string;
  tokenHash: string;
}

interface DeviceStore {
  grants: StoredGrant[];
  tokens: StoredDeviceToken[];
}

class DeviceStorageError extends Error {}

let deviceMutationQueue: Promise<void> = Promise.resolve();

const hashDeviceSecret = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const timedEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
};

const emptyStore = (): DeviceStore => ({ grants: [], tokens: [] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeStore = (input: unknown): DeviceStore => {
  if (!isRecord(input)) {
    return emptyStore();
  }

  const grants = Array.isArray(input.grants) ? input.grants : [];
  const tokens = Array.isArray(input.tokens) ? input.tokens : [];

  return {
    grants: grants
      .filter(
        (entry): entry is StoredGrant & Record<string, unknown> =>
          isRecord(entry) &&
          typeof entry.deviceCodeHash === 'string' &&
          typeof entry.userCodeHash === 'string' &&
          typeof entry.expiresAt === 'string',
      )
      .map((entry) => ({
        clientId:
          typeof entry.clientId === 'string'
            ? entry.clientId
            : DEVICE_CLIENT_ID,
        createdAt:
          typeof entry.createdAt === 'string'
            ? entry.createdAt
            : new Date(0).toISOString(),
        deviceCodeHash: entry.deviceCodeHash,
        expiresAt: entry.expiresAt,
        // Kept only when it is a loopback address and nothing else: it is where
        // a token is about to be sent, and a stored document is not a place to
        // keep an address this console would push a credential at.
        ...(typeof entry.redirectUri === 'string' &&
        isLoopbackRedirectUri(entry.redirectUri)
          ? { redirectUri: entry.redirectUri }
          : {}),
        status:
          entry.status === 'approved'
            ? ('approved' as const)
            : ('pending' as const),
        userCodeHash: entry.userCodeHash,
      })),
    tokens: tokens.filter(
      (entry): entry is StoredDeviceToken =>
        isRecord(entry) &&
        typeof entry.tokenHash === 'string' &&
        typeof entry.expiresAt === 'string' &&
        typeof entry.id === 'string',
    ),
  };
};

const pruneStore = (store: DeviceStore, now: number): DeviceStore => ({
  grants: store.grants.filter(
    (grant) => new Date(grant.expiresAt).getTime() > now,
  ),
  tokens: store.tokens.filter(
    (token) => new Date(token.expiresAt).getTime() > now,
  ),
});

const loadDeviceStore = async (): Promise<DeviceStore> => {
  const result = await readStorageJsonResult<DeviceStore>(
    DEVICE_NAMESPACE,
    DEVICE_KEY,
  );

  if (result.error) {
    throw new DeviceStorageError(result.error);
  }

  return pruneStore(normalizeStore(result.value), Date.now());
};

const mutateDeviceStore = async <T>(
  mutator: (store: DeviceStore) => T | Promise<T>,
): Promise<T> => {
  const operation = deviceMutationQueue.then(
    async () => {
      const store = await loadDeviceStore();
      const result = await mutator(store);

      await writeStorageJson(DEVICE_NAMESPACE, DEVICE_KEY, store);

      return result;
    },
    async () => {
      const store = await loadDeviceStore();

      return mutator(store);
    },
  );

  deviceMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation;
};

/** Keeps the newest: a grant asked for in a loop is dropped, not stored. */
const capped = <T>(entries: T[], max: number): T[] =>
  entries.slice(Math.max(0, entries.length - max));

const newUserCode = (): string => {
  const bytes = randomBytes(USER_CODE_GROUP_LENGTH * USER_CODE_GROUPS);
  const groups: string[] = [];
  let at = 0;

  for (let group = 0; group < USER_CODE_GROUPS; group += 1) {
    let text = '';

    for (let index = 0; index < USER_CODE_GROUP_LENGTH; index += 1) {
      text += USER_CODE_ALPHABET[(bytes[at] ?? 0) % USER_CODE_ALPHABET.length];
      at += 1;
    }

    groups.push(text);
  }

  return groups.join('-');
};

/**
 * A code as it is looked up: whatever the user typed, read in one shape.
 *
 * Dashes and spaces are dropped and case is folded, because the code is read off
 * one screen and typed into another — and a hyphen someone typed anyway must not
 * make a code they were shown look like one this console never issued.
 */
export const normalizeUserCode = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toUpperCase()
    .split('')
    .filter((character) => USER_CODE_ALPHABET.includes(character))
    .join('');
};

/**
 * Whether an address is one this console will send a browser back to.
 *
 * Loopback only, which is what makes it safe to hand a token to: a token in a
 * URL is a token anybody who can read that URL can use, and the only address a
 * native app is the sole listener on is its own machine's — see RFC 8252. A
 * deployment's own page, or a name that resolves somewhere else, is not a place
 * this console gets to push a credential at.
 */
export const isLoopbackRedirectUri = (value: string): boolean => {
  let parsed: URL;

  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  );
};

/**
 * The token, put on the address the device is listening on.
 *
 * Everything already in that address is kept — the `state` the device put there
 * to know the answer is the answer to its own question, most of all.
 */
const withToken = (redirectUri: string, token: string): string => {
  const parsed = new URL(redirectUri);

  parsed.searchParams.set('token', token);

  return parsed.toString();
};

/**
 * The codes a device starts from.
 *
 * `origin` is whatever address this console was reached on, because the browser
 * the user approves in has to be sent to the address the passkey was saved for
 * — a guess of `localhost` here would send them somewhere the passkey is not.
 *
 * `redirectUri` is the loopback address the browser is sent back to once the
 * user has approved, carrying the token with it, so that a device is told it has
 * been signed in instead of having to ask again and again until it is.
 */
export const requestDeviceAuthorization = async ({
  clientId = DEVICE_CLIENT_ID,
  origin,
  redirectUri = '',
}: {
  clientId?: string;
  origin: string;
  redirectUri?: string;
}): Promise<DeviceAuthorization> => {
  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url');
  const userCode = newUserCode();
  const now = Date.now();
  const root = origin.replace(/\/+$/, '');
  const grant: StoredGrant = {
    clientId: clientId.trim() || DEVICE_CLIENT_ID,
    createdAt: new Date(now).toISOString(),
    deviceCodeHash: hashDeviceSecret(deviceCode),
    expiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
    ...(isLoopbackRedirectUri(redirectUri)
      ? { redirectUri: redirectUri.trim() }
      : {}),
    status: 'pending',
    userCodeHash: hashDeviceSecret(normalizeUserCode(userCode)),
  };

  await mutateDeviceStore((store) => {
    store.grants = capped([...store.grants, grant], MAX_GRANTS);
  });

  return {
    device_code: deviceCode,
    expires_in: Math.round(GRANT_TTL_MS / 1000),
    interval: DEFAULT_POLL_INTERVAL_SECONDS,
    user_code: userCode,
    verification_uri: `${root}${DEVICE_VERIFICATION_PATH}`,
    verification_uri_complete: `${root}${DEVICE_VERIFICATION_PATH}?user_code=${encodeURIComponent(userCode)}`,
  };
};

/**
 * What the user's approval of a code does.
 *
 * `missing` is a code this console did not issue, or one that has run out: both
 * are one answer, because a caller that could tell them apart would only learn
 * which codes were ever issued.
 *
 * Nothing is handed to the device here — the grant only says it may be. The
 * token is minted when the device next asks, which is the only moment anyone is
 * waiting to carry it away.
 */
export const approveDeviceGrant = async ({
  userCode,
}: {
  userCode: string;
}): Promise<{
  clientId: string;
  /** Where the browser goes next, carrying the token, when the device asked. */
  redirect?: string;
  status: 'approved' | 'missing';
}> => {
  const wanted = normalizeUserCode(userCode);

  if (!wanted) {
    return { clientId: '', status: 'missing' };
  }

  const wantedHash = hashDeviceSecret(wanted);

  return mutateDeviceStore((store) => {
    const grant = store.grants.find((entry) =>
      timedEqual(entry.userCodeHash, wantedHash),
    );

    if (!grant) {
      return { clientId: '', status: 'missing' as const };
    }

    /*
      A device that named a loopback address of its own is told it has been
      signed in, rather than left to ask: the token is minted here and handed to
      the browser to carry home, which is what RFC 8252 is for — a native app
      with no secret to keep, and no reason to be polling for an answer somebody
      has already given.

      One that did not name one keeps asking, which is the only way it has of
      finding out.
    */
    if (!grant.redirectUri) {
      grant.status = 'approved';

      return { clientId: grant.clientId, status: 'approved' as const };
    }

    const token = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');
    const now = Date.now();
    const redirect = withToken(grant.redirectUri, token);

    store.tokens = capped(
      [
        ...store.tokens,
        {
          clientId: grant.clientId,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
          id: randomBytes(12).toString('hex'),
          tokenHash: hashDeviceSecret(token),
        },
      ],
      MAX_TOKENS,
    );
    store.grants = store.grants.filter((entry) => entry !== grant);

    return { clientId: grant.clientId, redirect, status: 'approved' as const };
  });
};

/**
 * The token a device asked for, or why it cannot have one yet.
 *
 * Answered in the shapes RFC 8628 names, which is also what a device that knows
 * them can act on: keep asking, or stop. The grant is spent the moment the token
 * is handed over, so a code that was approved once cannot hand out a second
 * token to whoever else comes asking with it.
 */
export const exchangeDeviceGrant = async ({
  deviceCode,
}: {
  deviceCode: string;
}): Promise<DeviceTokenResponse | { error: DeviceGrantError }> => {
  if (!deviceCode) {
    return { error: 'invalid_grant' };
  }

  const hash = hashDeviceSecret(deviceCode);
  const now = Date.now();

  return mutateDeviceStore((store) => {
    const grant = store.grants.find((entry) => entry.deviceCodeHash === hash);

    if (!grant) {
      // Gone because it was spent, or because it ran out. Telling a device
      // which would only tell it what happened on someone else's screen; it
      // stops asking either way.
      return { error: 'expired_token' as const };
    }

    if (grant.status !== 'approved') {
      return { error: 'authorization_pending' as const };
    }

    const token = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');

    store.tokens = capped(
      [
        ...store.tokens,
        {
          clientId: grant.clientId,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
          id: randomBytes(12).toString('hex'),
          tokenHash: hashDeviceSecret(token),
        },
      ],
      MAX_TOKENS,
    );
    store.grants = store.grants.filter((entry) => entry !== grant);

    return {
      access_token: token,
      expires_in: Math.round(TOKEN_TTL_MS / 1000),
      token_type: 'Bearer' as const,
    };
  });
};

/** Whether a token is one this console handed to a device it approved. */
const storedDeviceToken = async (
  token: string,
): Promise<StoredDeviceToken | null> => {
  const hash = hashDeviceSecret(token);
  const store = await loadDeviceStore();

  return (
    store.tokens.find(
      (entry) =>
        timedEqual(entry.tokenHash, hash) &&
        new Date(entry.expiresAt).getTime() > Date.now(),
    ) ?? null
  );
};

/** The bearer token a request carries, when it carries one. */
export const deviceBearerToken = (request: {
  headers: { get(name: string): string | null };
}): string | null => {
  const header = request.headers.get('authorization')?.trim() ?? '';
  const [scheme, ...rest] = header.split(/\s+/);

  if (scheme?.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join('').trim();

  return token || null;
};

/**
 * Whether a request is a device the user approved.
 *
 * Checked beside the session cookie rather than instead of it: both are the same
 * answer to "is this the admin", and a console with no sign-in at all never
 * asks either question.
 */
export const isDeviceTokenAuthorized = async (request: {
  headers: { get(name: string): string | null };
}): Promise<boolean> => {
  const token = deviceBearerToken(request);

  if (!token) {
    return false;
  }

  try {
    return (await storedDeviceToken(token)) !== null;
  } catch {
    // Storage that will not answer is not a token: a device cannot be signed
    // in by a console that cannot read what it approved.
    return false;
  }
};

/**
 * Forgets the token a request came in with.
 *
 * The device asks for it when the user signs out there: a token left good on
 * this console after the app has forgotten it is a key nobody can see.
 */
export const revokeDeviceToken = async (request: {
  headers: { get(name: string): string | null };
}): Promise<boolean> => {
  const token = deviceBearerToken(request);

  if (!token) {
    return false;
  }

  const hash = hashDeviceSecret(token);

  return mutateDeviceStore((store) => {
    const kept = store.tokens.filter(
      (entry) => !timedEqual(entry.tokenHash, hash),
    );

    const revoked = kept.length !== store.tokens.length;

    store.tokens = kept;

    return revoked;
  });
};

/**
 * Forgets every device this console has signed in, and every code it is holding
 * for one that has not finished.
 *
 * What the admin reaches for when a token has leaked: rotating the password, or
 * turning sign-in off. Both of them threw away the sessions of the browsers
 * that were signed in, and left these standing — a token is good for thirty
 * days and nothing on the console's side could end it early, so the answer to
 * "somebody else has one" was to wait.
 */
export const revokeAllDeviceTokens = async (): Promise<void> => {
  await mutateDeviceStore((store) => {
    store.grants = [];
    store.tokens = [];
  });
};

export { MAX_POLL_INTERVAL_SECONDS };

/** Whether a grant type is the one this console exchanges a device code for. */
export const isDeviceGrantType = (value: unknown): boolean =>
  value === DEVICE_GRANT_TYPE;

/**
 * An interval a client is told to wait, kept between the floor and the ceiling.
 * A number the client sent is not trusted: it is only ever the console's own.
 */
export const clampPollIntervalSeconds = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }

  return Math.min(
    MAX_POLL_INTERVAL_SECONDS,
    Math.max(MIN_POLL_INTERVAL_SECONDS, Math.round(parsed)),
  );
};
