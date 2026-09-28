/**
 * Asking a deployment to sign this app in, the way a device does.
 *
 * A desktop app has no secret it could keep and no browser of its own to sign in
 * in, and a passkey saved for a deployment cannot be used from a window at
 * `127.0.0.1` — a browser offers a credential to the origin it is on. So the app
 * asks the deployment for a pair of codes instead: one it polls with, one it
 * shows the user, who types it into a page the deployment itself serves, where
 * the passkey and the saved passwords do work.
 *
 * Nothing here runs anything: what is here is the request, the reading of what
 * comes back, and the waiting — all of it injectable, because the wait is the
 * part worth testing and the part no test should actually sit through.
 */

import { DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } from '../admin/device-client';

const DEVICE_ENDPOINT = '/admin-api/oauth/device';
const TOKEN_ENDPOINT = '/admin-api/oauth/token';
/** How long a deployment is given to answer one request. */
export const DEVICE_REQUEST_TIMEOUT_MS = 15_000;
/** How long to wait on top of what the deployment said the code is good for. */
const EXTRA_WAIT_MS = 5_000;
/** What `slow_down` adds to the interval, as RFC 8628 has it. */
const SLOW_DOWN_SECONDS = 5;

export interface DeviceGrant {
  deviceCode: string;
  /** How long the code is good for, in seconds. */
  expiresIn: number;
  intervalSeconds: number;
  userCode: string;
  /** Where the user approves: the deployment's own page. */
  verificationUri: string;
  verificationUriComplete: string;
}

export interface DeviceToken {
  accessToken: string;
  expiresIn: number;
}

export type DeviceRequest =
  | { grant: DeviceGrant; kind: 'granted' }
  /** A deployment with no administrator account, so nothing to sign in to. */
  | { kind: 'notConfigured' }
  | { kind: 'failed' };

export type DevicePollOutcome =
  | { kind: 'signedIn'; token: DeviceToken }
  /** The code ran out, or was spent, before anybody approved it. */
  | { kind: 'expired' }
  /** The deployment said no, or said something that is not an answer. */
  | { kind: 'failed' };

export type DevicePollError =
  | 'authorization_pending'
  | 'expired_token'
  | 'invalid_grant'
  | 'slow_down'
  | 'unknown';

type FetchLike = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: string;
    signal?: AbortSignal;
  },
) => Promise<{
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}>;

const stringField = (payload: unknown, name: string): string => {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  const value = record?.[name];

  return typeof value === 'string' ? value.trim() : '';
};

const secondsField = (payload: unknown, name: string, fallback: number) => {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  const parsed = Number(record?.[name]);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** The codes a deployment answered with, or null when it answered with none. */
export const deviceGrantFromPayload = (
  payload: unknown,
): DeviceGrant | null => {
  const deviceCode = stringField(payload, 'device_code');
  const userCode = stringField(payload, 'user_code');
  const uri = stringField(payload, 'verification_uri');

  if (!deviceCode || !userCode) {
    return null;
  }

  const complete = stringField(payload, 'verification_uri_complete');

  return {
    deviceCode,
    expiresIn: secondsField(payload, 'expires_in', 600),
    // A deployment that says "ask again in no time at all" is not one to hammer:
    // five seconds is what this app waits whatever it is told.
    intervalSeconds: Math.min(
      30,
      Math.max(1, secondsField(payload, 'interval', 5)),
    ),
    userCode,
    // Where the user approves: the deployment's own page. Given complete, or
    // with the code filled in — a device that cannot be shown where to go, with
    // the code already in the box, cannot be approved at all.
    verificationUri: uri,
    verificationUriComplete:
      complete ||
      (uri
        ? `${uri}${uri.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(userCode)}`
        : ''),
  };
};

/** The error a token endpoint answered with, in the shape RFC 8628 names. */
export const devicePollError = (payload: unknown): DevicePollError | null => {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : null;
  const error = record?.error;
  const name =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? String((error as { message?: unknown }).message ?? '')
        : '';

  switch (name) {
    case 'authorization_pending':
    case 'expired_token':
    case 'invalid_grant':
    case 'slow_down': {
      return name;
    }
    default: {
      return null;
    }
  }
};

export const deviceTokenFromPayload = (
  payload: unknown,
): DeviceToken | null => {
  const accessToken = stringField(payload, 'access_token');

  return accessToken
    ? { accessToken, expiresIn: secondsField(payload, 'expires_in', 0) }
    : null;
};

/**
 * The first half: two codes, neither of which is a credential.
 *
 * `notConfigured` is a deployment that has no administrator account at all — a
 * console with no sign-in has nothing for this app to be signed in to, which is
 * an answer worth saying out loud rather than a failure to report.
 */
export const requestDeviceAuthorization = async ({
  baseUrl,
  clientId = DEVICE_CLIENT_ID,
  fetchImpl = fetch as unknown as FetchLike,
  signal = AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS),
}: {
  baseUrl: string;
  clientId?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<DeviceRequest> => {
  const root = baseUrl.trim().replace(/\/+$/, '');

  try {
    const response = await fetchImpl(`${root}${DEVICE_ENDPOINT}`, {
      body: JSON.stringify({ client_id: clientId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    });

    if (response.status === 409) {
      return { kind: 'notConfigured' };
    }

    if (!response.ok) {
      return { kind: 'failed' };
    }

    const grant = deviceGrantFromPayload(await response.json());

    return grant ? { grant, kind: 'granted' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
};

/**
 * The second half: asking again until the user has approved, or until the code
 * runs out.
 *
 * The waiting is the point of a device: the approval happens on another screen,
 * in another app, whenever the user gets to it. `slow_down` is honoured by
 * waiting longer rather than by giving up, and a code that runs out is answered
 * as what it is — the end of an offer rather than a failure.
 */
export const pollForDeviceToken = async ({
  baseUrl,
  deviceCode,
  expiresIn,
  fetchImpl = fetch as unknown as FetchLike,
  intervalSeconds = 5,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
}: {
  baseUrl: string;
  deviceCode: string;
  expiresIn: number;
  fetchImpl?: FetchLike;
  intervalSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DevicePollOutcome> => {
  const root = baseUrl.trim().replace(/\/+$/, '');
  const deadline = Date.now() + expiresIn * 1000 + EXTRA_WAIT_MS;
  let interval = Math.max(1, intervalSeconds);

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    try {
      const response = await fetchImpl(`${root}${TOKEN_ENDPOINT}`, {
        body: JSON.stringify({
          client_id: DEVICE_CLIENT_ID,
          device_code: deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS),
      });

      const payload = await response.json();

      if (response.ok) {
        const token = deviceTokenFromPayload(payload);

        if (token) {
          return { kind: 'signedIn', token };
        }
      }

      const error = devicePollError(payload);

      if (error === 'slow_down') {
        interval += SLOW_DOWN_SECONDS;

        continue;
      }

      // Pending is the only answer that means "ask again". A grant that has run
      // out or been spent is the end of an offer, and anything else — a code
      // that is not one, an error this app does not know — is a no.
      if (error === 'expired_token') {
        return { kind: 'expired' };
      }

      if (error !== 'authorization_pending') {
        return { kind: 'failed' };
      }
    } catch {
      // A deployment that stopped answering, or one that answered with
      // something that is not JSON: asked again, until the code runs out.
    }
  }

  return { kind: 'expired' };
};
