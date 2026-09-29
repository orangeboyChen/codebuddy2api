import http from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  deviceGrantFromPayload,
  deviceTokenFromPayload,
  requestDeviceAuthorization,
  startDeviceRedirectListener,
} from '@/lib/server/electron/device-auth';
import { DEVICE_CLIENT_ID } from '@/lib/server/admin/device-client';

/**
 * The desktop half of a device sign-in: what it makes of what a deployment says.
 *
 * The waiting is what is worth covering, and it is the part no test should sit
 * through — the sleep and the fetch are both injected here, so a code that runs
 * out is a test that ends at once.
 */

const BASE = 'https://admin.example.com';

const grantPayload = {
  device_code: 'device-code',
  expires_in: 600,
  interval: 5,
  user_code: 'ABCD-EFGH',
  verification_uri: `${BASE}/device`,
  verification_uri_complete: `${BASE}/device?user_code=ABCD-EFGH`,
};

interface Call {
  body: string;
  url: string;
}

/** A fetch that answers with `responses` in turn and remembers what it was asked. */
const fetchStub = (
  responses: Array<{ payload: unknown; status?: number }>,
): { calls: Call[]; fetchImpl: never } => {
  const calls: Call[] = [];
  let at = 0;

  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push({ body: init.body, url });

    const response = responses[Math.min(at, responses.length - 1)];
    at += 1;

    return {
      json: async () => response.payload,
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
    };
  };

  return { calls, fetchImpl: fetchImpl as never };
};

/** A deployment that never answers at all. */
const unreachable = (): { calls: Call[]; fetchImpl: never } => {
  const calls: Call[] = [];

  return {
    calls,
    fetchImpl: (async (url: string, init: { body: string }) => {
      calls.push({ body: init.body, url });

      throw new Error('offline');
    }) as never,
  };
};

/**
 * The browser, coming home: a GET on the address the app is listening on, which
 * is what the deployment's own page does once the user has approved.
 */
const browseTo = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on('end', resolve);
    });

    request.on('error', reject);
  });

describe('what a deployment answered with', () => {
  it('reads the two codes it needs', () => {
    expect(deviceGrantFromPayload(grantPayload)).toEqual({
      deviceCode: 'device-code',
      expiresIn: 600,
      intervalSeconds: 5,
      userCode: 'ABCD-EFGH',
      verificationUri: `${BASE}/device`,
      verificationUriComplete: `${BASE}/device?user_code=ABCD-EFGH`,
    });
  });

  it('is no grant at all without either code', () => {
    expect(
      deviceGrantFromPayload({ ...grantPayload, device_code: '' }),
    ).toBeNull();
    expect(
      deviceGrantFromPayload({ ...grantPayload, user_code: '  ' }),
    ).toBeNull();
    expect(deviceGrantFromPayload(null)).toBeNull();
    expect(deviceGrantFromPayload([])).toBeNull();
  });

  it('fills the code in when the deployment only said where to go', () => {
    const grant = deviceGrantFromPayload({
      device_code: 'code',
      user_code: 'AB-CD',
      verification_uri: `${BASE}/device?locale=en`,
    });

    expect(grant?.verificationUri).toBe(`${BASE}/device?locale=en`);
    expect(grant?.verificationUriComplete).toBe(
      `${BASE}/device?locale=en&user_code=AB-CD`,
    );
  });

  it('has nowhere to send the user when it was told nowhere', () => {
    const grant = deviceGrantFromPayload({
      device_code: 'code',
      user_code: 'ABCD',
    });

    expect(grant?.verificationUri).toBe('');
    expect(grant?.verificationUriComplete).toBe('');
    expect(grant?.expiresIn).toBe(600);
    expect(grant?.intervalSeconds).toBe(5);
  });

  it('waits between a second and half a minute, whatever it was told', () => {
    // One that says "ask again in no time at all" is not one to hammer: five
    // seconds is what this app waits whatever it is told.
    expect(
      deviceGrantFromPayload({ ...grantPayload, interval: 0 })?.intervalSeconds,
    ).toBe(5);
    expect(
      deviceGrantFromPayload({ ...grantPayload, interval: 600 })
        ?.intervalSeconds,
    ).toBe(30);
    expect(
      deviceGrantFromPayload({ ...grantPayload, interval: 1 })?.intervalSeconds,
    ).toBe(1);
    expect(
      deviceGrantFromPayload({ ...grantPayload, expires_in: 'soon' })
        ?.expiresIn,
    ).toBe(600);
  });

  it('reads a token, and no token out of an answer with none in it', () => {
    expect(
      deviceTokenFromPayload({ access_token: 'token', expires_in: 100 }),
    ).toEqual({ accessToken: 'token', expiresIn: 100 });
    expect(deviceTokenFromPayload({ access_token: 'token' })).toEqual({
      accessToken: 'token',
      expiresIn: 0,
    });
    expect(deviceTokenFromPayload({ token_type: 'Bearer' })).toBeNull();
  });
});

describe('asking a deployment for a code', () => {
  it('is granted one', async () => {
    const { calls, fetchImpl } = fetchStub([{ payload: grantPayload }]);
    const outcome = await requestDeviceAuthorization({
      baseUrl: `${BASE}/`,
      fetchImpl,
    });

    expect(outcome).toMatchObject({ kind: 'granted' });
    expect(calls[0]?.url).toBe(`${BASE}/admin-api/oauth/device`);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      client_id: DEVICE_CLIENT_ID,
    });
  });

  it('is told there is nothing to sign in to', async () => {
    const { fetchImpl } = fetchStub([{ payload: {}, status: 409 }]);

    await expect(
      requestDeviceAuthorization({ baseUrl: BASE, fetchImpl }),
    ).resolves.toEqual({ kind: 'notConfigured' });
  });

  it('has failed when the deployment says nothing it can use', async () => {
    const incomplete = fetchStub([{ payload: { user_code: 'ABCD' } }]);
    const failing = fetchStub([{ payload: {}, status: 500 }]);

    await expect(
      requestDeviceAuthorization({
        baseUrl: BASE,
        fetchImpl: incomplete.fetchImpl,
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    await expect(
      requestDeviceAuthorization({
        baseUrl: BASE,
        fetchImpl: failing.fetchImpl,
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  it('has failed when the deployment cannot be reached', async () => {
    await expect(
      requestDeviceAuthorization({
        baseUrl: BASE,
        fetchImpl: unreachable().fetchImpl,
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });
});

describe('listening for the browser to come back', () => {
  it('is signed in by the token the browser brings home', async () => {
    const listener = await startDeviceRedirectListener({ state: 'a-state' });

    try {
      // The address the deployment is told to send the browser back to, and the
      // one the token is checked against: a token is a credential, and any page
      // on this machine could otherwise ask this address for one.
      expect(listener.redirectUri).toContain('127.0.0.1');
      expect(listener.redirectUri).toContain(encodeURIComponent('a-state'));

      const answered = listener.wait(30_000);

      await browseTo(`${listener.redirectUri}&token=a-token`);

      expect(await answered).toEqual({ accessToken: 'a-token', expiresIn: 0 });
    } finally {
      listener.close();
    }
  });

  it('takes no token from a browser this app did not open', async () => {
    const listener = await startDeviceRedirectListener({ state: 'a-state' });

    try {
      const answered = listener.wait(400);

      await browseTo(
        `${listener.redirectUri}&token=somebody-elses`.replace(
          'a-state',
          'another-state',
        ),
      );

      // Answered with nothing rather than with the wrong token: the wait runs
      // out, which is the same answer a browser closed on gets.
      expect(await answered).toBeNull();
    } finally {
      listener.close();
    }
  });

  it('answers with nothing when the browser never comes back', async () => {
    const listener = await startDeviceRedirectListener({ state: 'a-state' });

    try {
      expect(await listener.wait(50)).toBeNull();
    } finally {
      listener.close();
    }
  });
});
