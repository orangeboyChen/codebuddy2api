import fs from 'node:fs';
import path from 'node:path';

import {
  addCredential,
  listCredentials,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { getActiveConfig, updateSettings } from '@/lib/server/domain/config';
import { resetStorageRuntime, writeStorageJson } from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-expiry-notifications');
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
const nowSeconds = Math.floor(now.getTime() / 1000);
const DAY = 24 * 60 * 60;

const send = vi.fn<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>(async () => new Response('{}', { status: 200 }));
const authError = vi.hoisted(() =>
  vi.fn<(request: Request) => Promise<Response | null>>(async () => null),
);

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: authError,
}));

vi.stubGlobal('fetch', send);

const {
  runCredentialExpiryNotificationTick,
  sendBarkNotification,
  startCredentialExpiryNotificationScheduler,
  stopCredentialExpiryNotificationScheduler,
} = await import('@/lib/server/domain/credential-expiry-notifications');
const BarkTestRoute =
  await import('@/app/admin-api/notifications/bark/test/route');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const seed = async (
  filename: string,
  expiresIn: number,
  data: Record<string, unknown> = {},
): Promise<void> => {
  await addCredential(
    {
      bearer_token: 'token',
      created_at: nowSeconds,
      expires_in: expiresIn,
      user_id: 'tester@example.com',
      ...data,
    },
    filename,
  );
};

describe('credential expiry notifications', () => {
  beforeEach(async () => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    send.mockReset();
    send.mockResolvedValue(new Response('{}', { status: 200 }));
    authError.mockReset();
    authError.mockResolvedValue(null);
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_BARK_TOKEN;
    delete process.env.CODEBUDDY_CREDENTIAL_EXPIRY_NOTIFICATIONS_ENABLED;
    await updateSettings({
      CODEBUDDY_BARK_TOKEN: 'bark-token',
      CODEBUDDY_CREDENTIAL_EXPIRY_NOTIFICATIONS_ENABLED: true,
    });
  });

  afterEach(() => {
    stopCredentialExpiryNotificationScheduler();
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
  });

  it('does nothing when notifications are disabled or unconfigured', async () => {
    await seed('disabled.json', 3 * DAY);
    await updateSettings({
      CODEBUDDY_CREDENTIAL_EXPIRY_NOTIFICATIONS_ENABLED: false,
    });

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends each threshold once and persists the sent state', async () => {
    await seed('three-days.json', 3 * DAY - 5);
    expect((await getActiveConfig()).CODEBUDDY_BARK_TOKEN).toBe('bark-token');
    expect(
      (await getActiveConfig())
        .CODEBUDDY_CREDENTIAL_EXPIRY_NOTIFICATIONS_ENABLED,
    ).toBe(true);
    expect((await listCredentials()).credentials).toMatchObject([
      { expires_in: 3 * DAY - 5, time_remaining: 3 * DAY - 5 },
    ]);

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([
      'three-days.json:three_days',
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBe('https://api.day.app/push');
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
      device_key: 'bark-token',
      title: 'CodeBuddy2API 凭据提醒',
    });
    console.log(
      'STATE1',
      fs.readFileSync(
        path.join(tempRootDir, '.codebuddy_creds', 'expiry_notifications.json'),
        'utf8',
      ),
    );

    send.mockClear();
    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();

    const oneDay = new Date(now.getTime() + (2 * DAY + 60) * 1000);
    await expect(runCredentialExpiryNotificationTick(oneDay)).resolves.toEqual([
      'three-days.json:one_day',
    ]);
    const expired = new Date(now.getTime() + (3 * DAY + 60) * 1000);
    await expect(runCredentialExpiryNotificationTick(expired)).resolves.toEqual(
      ['three-days.json:expired'],
    );
  });

  it('uses the nearest threshold after a missed check', async () => {
    await seed('missed.json', DAY - 1);

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([
      'missed.json:one_day',
    ]);
  });

  it('ignores malformed state and credentials without expiry data', async () => {
    await writeStorageJson('credentials', 'expiry_notifications.json', {
      invalid: { expiresAt: 'not-a-number', sent: {} },
      malformed: null,
    });
    await writeStorageJson('credentials', 'missing-expiry.json', {
      bearer_token: 'token',
    });
    await writeStorageJson('credentials', 'filename-fallback.json', {
      bearer_token: 'token',
      created_at: nowSeconds,
      expires_in: DAY - 1,
    });
    await seed('email.json', 3 * DAY - 5, {
      user_info: { email: 'email@example.com' },
    });

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([
      'email.json:three_days',
      'filename-fallback.json:one_day',
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries a failed Bark request on the next tick', async () => {
    await seed('retry.json', 3 * DAY - 5);
    send.mockRejectedValueOnce(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();

    send.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([
      'retry.json:three_days',
    ]);
  });

  it('recovers when persisting notification state fails', async () => {
    await seed('state-error.json', 3 * DAY - 5);
    const storage = await import('@/lib/server/storage');
    const write = vi
      .spyOn(storage, 'writeStorageJson')
      .mockRejectedValueOnce(new Error('storage down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runCredentialExpiryNotificationTick(now)).resolves.toEqual([]);
    expect(write).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('sends a test notification and rejects an empty token', async () => {
    await expect(
      sendBarkNotification({ body: 'hello', title: 'test', token: '  ' }),
    ).rejects.toThrow('Bark token is empty');

    await expect(
      sendBarkNotification({ body: 'hello', title: 'test', token: ' token ' }),
    ).resolves.toBeUndefined();
  });

  it('serves the Bark test notification endpoint', async () => {
    const missing = await BarkTestRoute.POST(
      new Request('http://localhost/admin-api/notifications/bark/test', {
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(missing.status).toBe(400);

    const success = await BarkTestRoute.POST(
      new Request('http://localhost/admin-api/notifications/bark/test', {
        body: JSON.stringify({ token: 'token' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(success.status).toBe(200);

    send.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const failed = await BarkTestRoute.POST(
      new Request('http://localhost/admin-api/notifications/bark/test', {
        body: JSON.stringify({ token: 'token' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(failed.status).toBe(502);

    authError.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );
    const unauthorized = await BarkTestRoute.POST(
      new Request('http://localhost/admin-api/notifications/bark/test', {
        body: JSON.stringify({ token: 'token' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(unauthorized.status).toBe(401);
  });

  it('starts only one scheduler and can be stopped', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');

    startCredentialExpiryNotificationScheduler();
    startCredentialExpiryNotificationScheduler();

    expect(interval).toHaveBeenCalledTimes(1);
    stopCredentialExpiryNotificationScheduler();
    expect(clear).toHaveBeenCalledTimes(1);
    stopCredentialExpiryNotificationScheduler();
  });

  it('runs the scheduled sweep after startup and on the interval', async () => {
    vi.useFakeTimers();
    const config = await import('@/lib/server/domain/config');
    const getConfig = vi
      .spyOn(config, 'getActiveConfig')
      .mockRejectedValue(new Error('config unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      startCredentialExpiryNotificationScheduler();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 10_000);
      expect(warn).toHaveBeenCalled();
    } finally {
      stopCredentialExpiryNotificationScheduler();
      getConfig.mockRestore();
      vi.useRealTimers();
    }
  });
});
