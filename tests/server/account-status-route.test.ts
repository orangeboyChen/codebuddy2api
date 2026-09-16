import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: vi.fn(),
}));
vi.mock('@/lib/server/domain/account-status', () => ({
  checkinAccount: vi.fn(),
  checkinAccounts: vi.fn(),
  getAccountStatus: vi.fn(),
  getAccountStatusCredentials: vi.fn(),
}));
vi.mock('@/lib/server/domain/auto-checkin', () => ({
  updateAutoCheckinSettings: vi.fn(),
}));
vi.mock('@/lib/server/domain/auto-checkin-settings', () => ({
  isValidAutoCheckinTime: (value: unknown) =>
    typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value),
}));

const { updateAutoCheckinSettings } =
  await import('@/lib/server/domain/auto-checkin');

const { getAdminSessionErrorResponse } =
  await import('@/lib/server/admin/session');
const {
  checkinAccount,
  checkinAccounts,
  getAccountStatus,
  getAccountStatusCredentials,
} = await import('@/lib/server/domain/account-status');
const { GET, POST } = await import('@/app/admin-api/account-status/route');

const request = (body?: unknown): Request =>
  new Request('http://localhost/admin-api/account-status', {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
  });

describe('account status admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);
    vi.mocked(getAccountStatusCredentials).mockResolvedValue([] as never);
    vi.mocked(getAccountStatus).mockResolvedValue([]);
    vi.mocked(checkinAccounts).mockResolvedValue([]);
    vi.mocked(checkinAccount).mockResolvedValue({} as never);
    vi.mocked(updateAutoCheckinSettings).mockResolvedValue({
      enabled: true,
      time: '09:00',
    });
  });

  describe('auto check-in', () => {
    it('saves the enabled flag and time', async () => {
      const response = await POST(
        request({
          action: 'auto-checkin',
          enabled: true,
          filename: 'one.json',
          time: '08:30',
        }),
      );

      expect(response.status).toBe(200);
      expect(updateAutoCheckinSettings).toHaveBeenCalledWith('one.json', {
        enabled: true,
        time: '08:30',
      });
      await expect(response.json()).resolves.toEqual({
        autoCheckin: { enabled: true, time: '09:00' },
        filename: 'one.json',
      });
    });

    it('requires a filename', async () => {
      const response = await POST(
        request({ action: 'auto-checkin', enabled: true }),
      );

      expect(response.status).toBe(400);
      expect(updateAutoCheckinSettings).not.toHaveBeenCalled();
    });

    it('rejects a malformed time before touching storage', async () => {
      const response = await POST(
        request({
          action: 'auto-checkin',
          filename: 'one.json',
          time: '25:00',
        }),
      );

      expect(response.status).toBe(400);
      expect(updateAutoCheckinSettings).not.toHaveBeenCalled();
    });

    it('reports a failure to update', async () => {
      vi.mocked(updateAutoCheckinSettings).mockRejectedValueOnce(
        new Error('Credential is unavailable'),
      );

      const response = await POST(
        request({ action: 'auto-checkin', filename: 'gone.json' }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Credential is unavailable',
      });
    });

    it('leaves check-in and refresh actions untouched', async () => {
      await POST(request({ action: 'checkin', filename: 'one.json' }));

      expect(updateAutoCheckinSettings).not.toHaveBeenCalled();
      expect(checkinAccount).toHaveBeenCalledWith('one.json');
    });
  });

  it('requires an administrator session', async () => {
    const denied = Response.json({ error: 'unauthorized' }, { status: 401 });
    vi.mocked(getAdminSessionErrorResponse)
      .mockResolvedValueOnce(denied)
      .mockResolvedValueOnce(denied);

    expect((await GET(request())).status).toBe(401);
    expect((await POST(request({ action: 'refresh' }))).status).toBe(401);
  });

  it('returns credentials and statuses on GET', async () => {
    vi.mocked(getAccountStatusCredentials).mockResolvedValueOnce([
      { filename: 'one.json' },
    ] as never);
    vi.mocked(getAccountStatus).mockResolvedValueOnce([
      { filename: 'one.json' } as never,
    ]);

    const payload = await (await GET(request())).json();
    expect(payload).toEqual({
      credentials: [{ filename: 'one.json' }],
      statuses: [{ filename: 'one.json' }],
    });
  });

  it('supports refresh and single or batch check-in actions', async () => {
    await POST(request({ action: 'refresh', filename: ' one.json ' }));
    expect(getAccountStatus).toHaveBeenCalledWith(['one.json']);

    await POST(request({ action: 'checkin', filename: 'one.json' }));
    expect(checkinAccount).toHaveBeenCalledWith('one.json');

    await POST(request({ action: 'checkin' }));
    expect(checkinAccounts).toHaveBeenCalledWith();

    await POST(request({ action: 'unknown', filename: 42 }));
    expect(getAccountStatus).toHaveBeenCalledWith(undefined);
  });
});
