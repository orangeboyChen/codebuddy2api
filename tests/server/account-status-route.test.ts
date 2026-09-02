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
