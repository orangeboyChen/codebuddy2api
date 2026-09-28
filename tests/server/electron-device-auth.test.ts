import { describe, expect, it, vi } from 'vitest';

import {
  deviceGrantFromPayload,
  devicePollError,
  deviceTokenFromPayload,
  pollForDeviceToken,
  requestDeviceAuthorization,
} from '@/lib/server/electron/device-auth';
import {
  DEVICE_CLIENT_ID,
  DEVICE_GRANT_TYPE,
} from '@/lib/server/admin/device-client';

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

const sleepNow = (): Promise<void> => Promise.resolve();

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

  it('names the errors a token endpoint answers with', () => {
    expect(devicePollError({ error: 'authorization_pending' })).toBe(
      'authorization_pending',
    );
    expect(devicePollError({ error: 'slow_down' })).toBe('slow_down');
    expect(devicePollError({ error: 'expired_token' })).toBe('expired_token');
    expect(devicePollError({ error: 'invalid_grant' })).toBe('invalid_grant');
    // An error it does not know is not one it knows how to wait through.
    expect(devicePollError({ error: 'access_denied' })).toBeNull();
    expect(devicePollError({})).toBeNull();
    expect(devicePollError('nope')).toBeNull();
    expect(devicePollError({ error: { message: 'expired_token' } })).toBe(
      'expired_token',
    );
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
    ).resolves.toEqual({ kind: 'failed' });
    await expect(
      requestDeviceAuthorization({
        baseUrl: BASE,
        fetchImpl: failing.fetchImpl,
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });

  it('has failed when the deployment cannot be reached', async () => {
    await expect(
      requestDeviceAuthorization({
        baseUrl: BASE,
        fetchImpl: unreachable().fetchImpl,
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });
});

describe('waiting for the user to approve', () => {
  it('is signed in the moment the deployment has a token', async () => {
    const { calls, fetchImpl } = fetchStub([
      { payload: { error: 'authorization_pending' }, status: 400 },
      { payload: { access_token: 'token', expires_in: 100 } },
    ]);
    const outcome = await pollForDeviceToken({
      baseUrl: BASE,
      deviceCode: 'device-code',
      expiresIn: 600,
      fetchImpl,
      intervalSeconds: 1,
      sleep: sleepNow,
    });

    expect(outcome).toEqual({
      kind: 'signedIn',
      token: { accessToken: 'token', expiresIn: 100 },
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      client_id: DEVICE_CLIENT_ID,
      device_code: 'device-code',
      grant_type: DEVICE_GRANT_TYPE,
    });
  });

  it('waits longer when the deployment asks it to slow down', async () => {
    const waited: number[] = [];
    const { calls, fetchImpl } = fetchStub([
      { payload: { error: 'slow_down' }, status: 400 },
      { payload: { access_token: 'token' } },
    ]);
    const outcome = await pollForDeviceToken({
      baseUrl: BASE,
      deviceCode: 'device-code',
      expiresIn: 600,
      fetchImpl,
      intervalSeconds: 2,
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    expect(outcome.kind).toBe('signedIn');
    // Two seconds as it was told, then five more: `slow_down` is answered by
    // waiting longer, not by giving up.
    expect(waited).toEqual([2000, 7000]);
    expect(calls).toHaveLength(2);
  });

  it('stops asking when the code has run out', async () => {
    const { fetchImpl } = fetchStub([
      { payload: { error: 'expired_token' }, status: 400 },
    ]);

    await expect(
      pollForDeviceToken({
        baseUrl: BASE,
        deviceCode: 'device-code',
        expiresIn: 600,
        fetchImpl,
        sleep: sleepNow,
      }),
    ).resolves.toEqual({ kind: 'expired' });
  });

  it.each([
    { error: 'invalid_grant', why: 'a code that is not one' },
    { error: 'access_denied', why: 'an answer it does not know' },
  ])('stops asking at $why', async ({ error }) => {
    const { fetchImpl } = fetchStub([{ payload: { error }, status: 400 }]);

    await expect(
      pollForDeviceToken({
        baseUrl: BASE,
        deviceCode: 'device-code',
        expiresIn: 600,
        fetchImpl,
        sleep: sleepNow,
      }),
    ).resolves.toEqual({ kind: 'failed' });
  });

  it('asks again while the deployment is silent, until the code runs out', async () => {
    const start = Date.now();
    let now = start;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { calls, fetchImpl } = unreachable();

    try {
      const outcome = await pollForDeviceToken({
        baseUrl: BASE,
        deviceCode: 'device-code',
        expiresIn: 1,
        fetchImpl,
        intervalSeconds: 1,
        sleep: async () => {
          now += 1_000;
        },
      });

      expect(outcome).toEqual({ kind: 'expired' });
      // Once a second for the second the code was good for, then the five it is
      // given on top of that.
      expect(calls).toHaveLength(6);
    } finally {
      clock.mockRestore();
    }
  });
});
