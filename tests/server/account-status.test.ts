import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', () => ({
  getCredentialSupportedModelDetails: vi.fn(),
  getCredentialSupportedModels: vi.fn(),
  listCredentials: vi.fn(),
  listEligibleCredentialRecords: vi.fn(),
  updateCredentialSupportedModelCatalog: vi.fn(),
  updateCredentialSupportedModelDetail: vi.fn(),
}));
vi.mock('@/lib/server/proxy/codebuddy', () => ({
  getModelsForCredential: vi.fn(),
}));

const { getCodeBuddyApiEndpoint } = await import('@/lib/server/domain/config');
const {
  getCredentialSupportedModelDetails,
  getCredentialSupportedModels,
  listCredentials,
  listEligibleCredentialRecords,
  updateCredentialSupportedModelCatalog,
  updateCredentialSupportedModelDetail,
} = await import('@/lib/server/domain/credentials');
const { getModelsForCredential } = await import('@/lib/server/proxy/codebuddy');
const {
  checkinAccount,
  checkinAccounts,
  getAccountStatus,
  getAccountStatusCredentials,
  resetCredentialModelDiscoveryFailures,
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
    // The discovery cooldown lives in module state, so a failure recorded by
    // one case would silently skip discovery in the next.
    resetCredentialModelDiscoveryFailures();
    // restore, not just clear: a fetch spy left with an implementation leaks
    // into the next case, and clearAllMocks only drops call records.
    vi.restoreAllMocks();
    vi.mocked(getCodeBuddyApiEndpoint).mockResolvedValue(
      'https://codebuddy.example.test',
    );
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      credential('one.json'),
    ] as never);
    vi.mocked(listCredentials).mockResolvedValue({ credentials: [] } as never);
    vi.mocked(getCredentialSupportedModelDetails).mockReturnValue([]);
    vi.mocked(getCredentialSupportedModels).mockReturnValue([]);
    vi.mocked(updateCredentialSupportedModelCatalog).mockResolvedValue();
    vi.mocked(updateCredentialSupportedModelDetail).mockResolvedValue();
    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Model One', id: 'model-one' },
    ]);
  });

  // A spy restored after an assertion never runs when that assertion throws,
  // which leaves console.warn mocked for everything that follows.
  afterEach(() => {
    vi.restoreAllMocks();
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
      models: [{ displayName: 'Model One', id: 'model-one' }],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached model catalog instead of querying upstream', async () => {
    const cached = [
      {
        credits: 'x3.33',
        descriptionZh: '通用模型',
        displayName: 'GLM 5.3',
        id: 'glm-5.3',
        isEnterprise: true,
      },
    ];
    vi.mocked(getCredentialSupportedModelDetails).mockReturnValue(cached);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ userQuota: { total: 1, used: 0, remaining: 1 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.models).toEqual(cached);
    expect(getModelsForCredential).not.toHaveBeenCalled();
  });

  it('caches the catalog after a live model discovery', async () => {
    const discovered = [
      { credits: 'x1.5', displayName: 'Model One', id: 'model-one' },
    ];
    vi.mocked(getModelsForCredential).mockResolvedValue(discovered);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    // Spelled out rather than compared against the mock's own return value:
    // the point is that discovery's models reach the caller unchanged.
    expect(result.models).toEqual([
      { credits: 'x1.5', displayName: 'Model One', id: 'model-one' },
    ]);
    expect(updateCredentialSupportedModelDetail).toHaveBeenCalledWith(
      'one.json',
      discovered,
    );
  });

  it('keeps discovered models when the catalog cannot be cached', async () => {
    vi.mocked(updateCredentialSupportedModelDetail).mockRejectedValue(
      new Error('storage unavailable'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.models).toEqual([
      { displayName: 'Model One', id: 'model-one' },
    ]);
    expect(result.error).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to saved model ids when discovery finds nothing', async () => {
    vi.mocked(getCredentialSupportedModels).mockReturnValue(['glm-5.1']);
    vi.mocked(getModelsForCredential).mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.models).toEqual([{ displayName: 'glm-5.1', id: 'glm-5.1' }]);
    expect(updateCredentialSupportedModelDetail).not.toHaveBeenCalled();
  });

  it('falls back to saved model ids when discovery fails', async () => {
    vi.mocked(getCredentialSupportedModels).mockReturnValue(['glm-5.1']);
    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('models unavailable'),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.models).toEqual([{ displayName: 'glm-5.1', id: 'glm-5.1' }]);
    // The saved ids still describe the account, so an unreachable upstream must
    // not turn the whole card red.
    expect(result.error).toBeNull();
  });

  it('reports a failed discovery when no saved ids can stand in', async () => {
    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('models unavailable'),
    );
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ userQuota: { total: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.models).toEqual([]);
    expect(result.error).toContain('models unavailable');
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

  const enterpriseCredential = (filename: string) => ({
    data: {
      bearer_token: `token-${filename}`,
      enterprise_id: 'tenant-42',
    },
    filePath: `/tmp/${filename}`,
    filename,
  });

  it('reads enterprise credits from the tenant meter', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ credit: 250, limitNum: 1000 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    // A tenant seat is billed per tenant, so the package list is never asked.
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/v2/billing/meter/get-enterprise-user-usage',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.error).toBeNull();
    expect(result.credits).toEqual({
      plan: null,
      remaining: 750,
      resetAt: null,
      total: 1000,
      used: 250,
    });
  });

  it('unwraps the meter envelope and normalizes a numeric reset time', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            data: {
              credit: 12,
              cycleResetTime: 1766000000000,
              limitNum: 60,
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.credits).toEqual({
      plan: null,
      remaining: 48,
      resetAt: new Date(1766000000000).toISOString(),
      total: 60,
      used: 12,
    });
  });

  it('keeps a string reset time exactly as the meter reports it', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            credit: 5,
            cycleResetTime: '2026-10-01T00:00:00Z',
            limitNum: 20,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.credits.resetAt).toBe('2026-10-01T00:00:00Z');
    expect(result.credits.remaining).toBe(15);
  });

  it('retries the tenant meter without the version prefix when it 404s', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ credit: 1, limitNum: 10 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/v2/billing/meter/get-enterprise-user-usage',
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/billing/meter/get-enterprise-user-usage',
    );
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('/v2/');
    expect(result.error).toBeNull();
    expect(result.credits.remaining).toBe(9);
  });

  it('falls back to the package list when the meter reports no limit', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: {} }))
      .mockResolvedValueOnce(
        jsonResponse({
          userQuota: { plan: 'Team', remaining: 35, total: 40, used: 5 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/v2/billing/meter/get-user-resource',
    );
    expect(result.error).toBeNull();
    expect(result.credits).toEqual({
      plan: 'Team',
      remaining: 35,
      resetAt: null,
      total: 40,
      used: 5,
    });
  });

  it('reports a tenant meter failure without hiding the package list', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(
        jsonResponse({ userQuota: { remaining: 5, total: 8, used: 3 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(result.error).toContain(
      '/v2/billing/meter/get-enterprise-user-usage returned 500',
    );
    expect(result.credits.remaining).toBe(5);
  });

  it('retries the tenant meter when it answers 405', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}, 405))
      .mockResolvedValueOnce(jsonResponse({ limitNum: 10 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(String(fetchMock.mock.calls[1][0])).not.toContain('/v2/');
    expect(result.error).toBeNull();
    // No credit in the payload, so nothing has been spent yet.
    expect(result.credits).toEqual({
      plan: null,
      remaining: 10,
      resetAt: null,
      total: 10,
      used: 0,
    });
  });

  it('falls back to the package list when the meter is not an object', async () => {
    vi.mocked(listEligibleCredentialRecords).mockResolvedValue([
      enterpriseCredential('ent.json'),
    ] as never);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse('unavailable'))
      .mockResolvedValueOnce(
        jsonResponse({ userQuota: { remaining: 7, total: 9, used: 2 } }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'CLAIMED' }));

    const [result] = await getAccountStatus();

    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/v2/billing/meter/get-user-resource',
    );
    expect(result.error).toBeNull();
    expect(result.credits.remaining).toBe(7);
  });
});
