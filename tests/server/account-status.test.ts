import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', () => ({
  listCredentials: vi.fn(),
  listEligibleCredentialRecords: vi.fn(),
}));
vi.mock('@/lib/server/proxy/codebuddy', () => ({
  getModelsForCredential: vi.fn(),
}));

const { getCodeBuddyApiEndpoint } = await import('@/lib/server/domain/config');
const { listCredentials, listEligibleCredentialRecords } =
  await import('@/lib/server/domain/credentials');
const { getModelsForCredential } = await import('@/lib/server/proxy/codebuddy');
const {
  checkinAccount,
  checkinAccounts,
  getAccountStatus,
  getAccountStatusCredentials,
} = await import('@/lib/server/domain/account-status');

const credential = (filename: string) => ({
  data: { bearer_token: `token-${filename}` },
  filePath: `/tmp/${filename}`,
  filename,
});
const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

describe('account status domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCodeBuddyApiEndpoint).mockResolvedValue(
      'https://codebuddy.example.test',
    );
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
    ] as never);
    vi.mocked(listCredentials).mockResolvedValue({ credentials: [] } as never);
    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Model One', id: 'model-one' },
    ]);
  });

  it('normalizes quota, check-in, and models', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          userQuota: { total: 1000, used: 250, remaining: 750, plan: 'Pro' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));
    const [result] = await getAccountStatus();
    expect(result).toMatchObject({
      credits: { total: 1000, used: 250, remaining: 750, plan: 'Pro' },
      checkin: { claimed: true },
      models: ['model-one'],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records partial upstream errors', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 0 } }))
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({}, 404));
    vi.mocked(getModelsForCredential).mockRejectedValueOnce(
      new Error('models unavailable'),
    );
    const [result] = await getAccountStatus();
    expect(result.credits.total).toBe(0);
    expect(result.error).toContain('returned 404');
    expect(result.error).toContain('models unavailable');
  });

  it('keeps unsupported quota and check-in values unknown', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              limits: {
                planName: 'Team',
                quota: 'not-a-number',
                reset_at: 'tomorrow',
                total_remain: '3',
                total_used: '2',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'PENDING' }));

    const [result] = await getAccountStatus();

    expect(result).toMatchObject({
      checkin: { claimed: false, message: 'PENDING' },
      credits: {
        plan: 'Team',
        remaining: 3,
        resetAt: 'tomorrow',
        total: null,
        used: 2,
      },
    });
  });

  it('searches nested arrays and supports access-token credentials', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValueOnce([
      {
        data: { access_token: 'access-token-only' },
        filePath: '/tmp/array.json',
        filename: 'array.json',
      },
    ] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ total: 12, used: 4, remaining: 8 }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [{ claimed: true }] }));

    const [result] = await getAccountStatus();

    expect(result.credits).toMatchObject({ total: 12, used: 4, remaining: 8 });
    expect(result.checkin.claimed).toBe(true);
  });

  it('returns the configured credential summaries', async () => {
    vi.mocked(listCredentials).mockResolvedValueOnce({
      credentials: [{ filename: 'summary.json' }],
    } as never);

    await expect(getAccountStatusCredentials()).resolves.toEqual([
      { filename: 'summary.json' },
    ]);
  });

  it('handles non-Error upstream failures without discarding other results', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce('quota unavailable')
      .mockResolvedValueOnce(jsonResponse({ checkedIn: false }));
    vi.mocked(getModelsForCredential).mockRejectedValueOnce(
      'models unavailable',
    );

    const [result] = await getAccountStatus();

    expect(result.checkin.claimed).toBe(false);
    expect(result.error).toContain('Credits query failed');
    expect(result.error).toContain('Model query failed');
  });

  it('checks in and refreshes one account', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(
        jsonResponse({ userQuota: { total: 10, used: 2, remaining: 8 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ claimed: true }));
    const result = await checkinAccount('one.json');
    expect(result.credits.remaining).toBe(8);
  });

  it('returns a refreshed error snapshot when check-in fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          userQuota: { quota: 3, total_remain: 2, total_used: 1 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ isClaimed: false }));

    const result = await checkinAccount('one.json');

    expect(result.error).toContain('claim returned 503');
    expect(result.credits).toMatchObject({ remaining: 2, total: 3, used: 1 });
  });

  it('rejects a check-in request for a missing credential', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValueOnce([] as never);

    await expect(checkinAccount('missing.json')).rejects.toThrow(
      'Credential is unavailable',
    );
  });

  it('processes all batch accounts', async () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      credential(`credential-${index}.json`),
    );
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue(
      records as never,
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? jsonResponse({ success: true })
        : jsonResponse({ userQuota: { total: 1, used: 0, remaining: 1 } }),
    );
    const results = await checkinAccounts();
    expect(results).toHaveLength(5);
  });
});
