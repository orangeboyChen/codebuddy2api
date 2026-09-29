/**
 * Asking a deployment to sign this app in, the way a device does.
 *
 * A desktop app has no secret it could keep and no browser of its own to sign in
 * in, and a passkey saved for a deployment cannot be used from a window at
 * `127.0.0.1` — a browser offers a credential to the origin it is on. So the app
 * asks the deployment for a code, sends the user to the deployment's own page to
 * approve it in a browser, and listens on loopback for the token the browser
 * brings back: RFC 8252, which is what a native app does instead of polling.
 *
 * Nothing here runs anything: what is here is the request, the reading of what
 * comes back, and the wait for the browser — all of it injectable, because the
 * wait is the part worth testing and the part no test should actually sit
 * through.
 */

import { createServer } from 'node:http';

import { DEVICE_CLIENT_ID } from '../admin/device-client';

const DEVICE_ENDPOINT = '/admin-api/oauth/device';
/** How long a deployment is given to answer one request. */
export const DEVICE_REQUEST_TIMEOUT_MS = 15_000;

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
  /**
   * A deployment that answered, or did not, without anything to sign in with.
   *
   * What it said is carried back: "the deployment did not sign this app in" is
   * true of a wrong address, of another desktop install refusing the request,
   * and of a proxy answering for the host — and none of those can be told apart
   * from the message alone.
   */
  | { kind: 'failed'; message: string; status: number };

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
  text: () => Promise<string>;
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
/** What a deployment that answered nothing usable said, as much of it as is worth carrying. */
const whatItSaid = async (response: {
  status: number;
  text: () => Promise<string>;
}): Promise<{ message: string; status: number }> => {
  let message = '';

  try {
    message = (await response.text()).trim().slice(0, 200);
  } catch {
    // A body that cannot be read is not worth failing the sign-in over.
  }

  return { message, status: response.status };
};

export const requestDeviceAuthorization = async ({
  baseUrl,
  clientId = DEVICE_CLIENT_ID,
  fetchImpl = fetch as unknown as FetchLike,
  redirectUri = '',
  signal = AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS),
}: {
  baseUrl: string;
  clientId?: string;
  fetchImpl?: FetchLike;
  /** Where the deployment sends the browser back to, carrying the token. */
  redirectUri?: string;
  signal?: AbortSignal;
}): Promise<DeviceRequest> => {
  const root = baseUrl.trim().replace(/\/+$/, '');

  try {
    const response = await fetchImpl(`${root}${DEVICE_ENDPOINT}`, {
      body: JSON.stringify({
        client_id: clientId,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    });

    if (response.status === 409) {
      return { kind: 'notConfigured' };
    }

    if (!response.ok) {
      return { ...(await whatItSaid(response)), kind: 'failed' };
    }

    const grant = deviceGrantFromPayload(await response.json());

    return grant
      ? { grant, kind: 'granted' }
      : { ...(await whatItSaid(response)), kind: 'failed' };
  } catch {
    return { kind: 'failed', message: '', status: 0 };
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

/**
 * The address the deployment sends the browser back to, and the token it is
 * carrying when it does.
 *
 * RFC 8252's loopback redirect: a native app has no secret it could keep and no
 * address of its own on the network, so instead of asking again and again
 * whether the user has approved, it listens on its own machine for one answer
 * and lets the browser bring it home.
 *
 * The port is whatever the machine has going, which is why the listener is
 * started before the grant is asked for: the address has to be named in the
 * request.
 */
export interface DeviceRedirectListener {
  close: () => void;
  /** What is handed to the deployment, and what the browser is sent back to. */
  redirectUri: string;
  /**
   * Resolves with the token the browser brought back, or null when the promise
   * ran out before it did — a browser that was closed on, or a user who never
   * approved, is answered the same way: there is nothing to sign in with.
   */
  wait: (timeoutMs: number) => Promise<DeviceToken | null>;
}

/** How long the browser is given to come back after the user has approved. */
const CALLBACK_GRACE_MS = 5_000;

/** The page the browser is left on: the approval is over, and this is the app's. */
const CALLBACK_PAGE =
  '<!doctype html><title>CodeBuddy2API</title>' +
  '<meta charset="utf-8">' +
  '<p style="font:16px/1.5 -apple-system,system-ui,sans-serif;text-align:center;' +
  'margin-top:15vh">Signed in. This tab can be closed.</p>';

export const startDeviceRedirectListener = async (options: {
  /** Answered back on the redirect, so a token is only taken from a browser this app opened. */
  state: string;
}): Promise<DeviceRedirectListener> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(CALLBACK_PAGE);

    // Only the answer to this question: a token is a credential, and any page
    // on this machine can ask this address for one.
    if (token && url.searchParams.get('state') === options.state) {
      settle({ expiresIn: 0, token });
    }
  });

  let settle: (
    outcome: { expiresIn: number; token: string } | null,
  ) => void = () => {};
  const answered = new Promise<{ expiresIn: number; token: string } | null>(
    (resolve) => {
      settle = (outcome) => resolve(outcome);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    server.close();

    throw new Error('The loopback listener has no port to answer on.');
  }

  const redirectUri = `http://127.0.0.1:${address.port}/?state=${encodeURIComponent(options.state)}`;
  let timer: NodeJS.Timeout | null = null;

  return {
    close: () => {
      if (timer) {
        clearTimeout(timer);
      }

      server.close();
    },
    redirectUri,
    wait: async (timeoutMs) => {
      const outcome = await Promise.race([
        answered,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            resolve(null);
            // Approved and on its way back: the browser is given a moment to
            // land it before the listener is taken away.
          }, timeoutMs + CALLBACK_GRACE_MS);
        }),
      ]);

      return outcome
        ? { accessToken: outcome.token, expiresIn: outcome.expiresIn }
        : null;
    },
  };
};
