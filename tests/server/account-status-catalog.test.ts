import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: vi.fn(),
}));
vi.mock('@/lib/server/proxy/codebuddy', () => ({
  getModelsForCredential: vi.fn(),
}));

const { getCodeBuddyApiEndpoint } = await import('@/lib/server/domain/config');
const { getModelsForCredential } = await import('@/lib/server/proxy/codebuddy');
const {
  addCredential,
  findCredentialRecordByFilename,
  getCredentialSupportedModelDetails,
  getCredentialSupportedModels,
  resetCredentialRuntimeState,
  updateCredentialSupportedModelDetail,
} = await import('@/lib/server/domain/credentials');
const {
  getAccountStatus,
  MODEL_DISCOVERY_COOLDOWN_MS,
  resetCredentialModelDiscoveryFailures,
} = await import('@/lib/server/domain/account-status');
const { resetStorageRuntime } = await import('@/lib/server/storage');

const tempRootDir = path.join(
  process.cwd(),
  '.tmp-test-account-status-catalog',
);

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const addAccount = async (
  data: Record<string, unknown>,
  filename: string,
): Promise<string> => {
  const created = await addCredential(
    { bearer_token: 'catalog-token', user_id: 'catalog@example.com', ...data },
    filename,
  );

  return created.filename;
};

describe('account status model catalog caching', () => {
  beforeEach(async () => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    resetCredentialModelDiscoveryFailures();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    vi.mocked(getCodeBuddyApiEndpoint).mockResolvedValue(
      'https://cb.example.test',
    );
    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ userQuota: { remaining: 1, total: 1, used: 0 } }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('leaves the routing whitelist alone when a page view caches details', async () => {
    const filename = await addAccount(
      { supported_models: 'curated-a,curated-b' },
      'curated',
    );

    const [snapshot] = await getAccountStatus([filename]);

    // The card shows what upstream offers...
    expect(snapshot.models).toEqual([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);

    // ...but `supported_models` is the whitelist `resolveCredentialForRequest`
    // routes by, and nothing here asked for it to be rewritten.
    const stored = await findCredentialRecordByFilename(filename);
    expect(getCredentialSupportedModels(stored?.data)).toEqual([
      'curated-a',
      'curated-b',
    ]);
    expect(getCredentialSupportedModelDetails(stored?.data)).toMatchObject([
      { id: 'upstream-1' },
    ]);
  });

  it('stops rediscovering for a credential whose discovery just failed', async () => {
    const filename = await addAccount({}, 'flaky');
    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('upstream unreachable'),
    );

    await getAccountStatus([filename]);
    await getAccountStatus([filename]);
    await getAccountStatus([filename]);

    // One attempt per cooldown window, not one per page load: eight accounts
    // against a hung upstream measured 30s per load without this.
    expect(getModelsForCredential).toHaveBeenCalledTimes(1);
  });

  it('stops rediscovering for a credential whose discovery found nothing', async () => {
    const filename = await addAccount({}, 'empty');
    vi.mocked(getModelsForCredential).mockResolvedValue([]);

    await getAccountStatus([filename]);
    await getAccountStatus([filename]);

    expect(getModelsForCredential).toHaveBeenCalledTimes(1);
  });

  it('asks upstream again once the cooldown has lapsed', async () => {
    const filename = await addAccount({}, 'lapsed');
    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('upstream unreachable'),
    );
    vi.useFakeTimers();

    await getAccountStatus([filename]);
    expect(getModelsForCredential).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MODEL_DISCOVERY_COOLDOWN_MS - 1);
    await getAccountStatus([filename]);
    expect(getModelsForCredential).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await getAccountStatus([filename]);
    expect(getModelsForCredential).toHaveBeenCalledTimes(2);
  });

  it('keeps serving saved ids while a discovery is cooling down', async () => {
    const filename = await addAccount({ supported_models: 'saved-a' }, 'saved');
    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('upstream unreachable'),
    );

    const first = await getAccountStatus([filename]);

    // The saved ids still describe the account, so an unreachable upstream
    // must not turn the card red or leave it without models.
    expect(first[0]?.models).toEqual([
      { displayName: 'saved-a', id: 'saved-a' },
    ]);
    expect(first[0]?.error).toBeNull();

    const second = await getAccountStatus([filename]);

    expect(second[0]?.models).toEqual([
      { displayName: 'saved-a', id: 'saved-a' },
    ]);
    expect(getModelsForCredential).toHaveBeenCalledTimes(1);
  });

  it('trims a catalog too large to cache instead of writing it whole', async () => {
    const filename = await addAccount({}, 'huge');

    await updateCredentialSupportedModelDetail(
      filename,
      Array.from({ length: 1500 }, (_, index) => ({
        credits: 'x3.33',
        descriptionZh: '描述'.repeat(80),
        displayName: `Model ${index}`,
        id: `model-${index}`,
        relatedModels: { lite: `model-${index}-lite` },
        vendor: 'e',
      })),
    );

    const stored = await findCredentialRecordByFilename(filename);
    const raw = stored?.data?.supported_models_detail;

    // The credential namespace is encrypted whole on every write, so a catalog
    // is trimmed rather than cached unbounded.
    expect(typeof raw).toBe('string');
    expect((raw ?? '').length).toBeLessThanOrEqual(256 * 1024);

    const details = getCredentialSupportedModelDetails(stored?.data);

    expect(details.length).toBeGreaterThan(0);
    // What survives still routes and still renders; the bulk that went is the
    // descriptions and the per-model extras.
    expect(details[0]?.id).toBe('model-0');
    expect(details[0]?.vendor).toBe('e');
    expect(details[0]?.descriptionZh).toBeUndefined();
    expect(details[0]?.relatedModels).toBeUndefined();
  });

  it('sheds a campaign before it sheds models, and drops one it cannot trim', async () => {
    const build = (count: number, withPromotion: boolean) =>
      Array.from({ length: count }, (_, index) => ({
        descriptionZh: '描述'.repeat(80),
        displayName: `Model ${index}`,
        id: `model-${index}`,
        ...(withPromotion
          ? {
              promotion: {
                label: '限时免费',
                textZh: '说明'.repeat(80),
              },
            }
          : {}),
      }));

    const promoted = await addAccount({}, 'promoted-huge');

    await updateCredentialSupportedModelDetail(promoted, build(1500, true));

    // The promotion copy is the first thing to go.
    expect(
      getCredentialSupportedModelDetails(
        (await findCredentialRecordByFilename(promoted))?.data,
      )[0]?.promotion?.textZh,
    ).toBeUndefined();

    const enormous = await addAccount({}, 'enormous');

    // One model that cannot be trimmed: an id far longer than the budget.
    await updateCredentialSupportedModelDetail(enormous, [
      { displayName: 'Huge', id: 'i'.repeat(400_000) },
    ]);

    // Better no cache than a credential document written whole on every save.
    expect(
      (await findCredentialRecordByFilename(enormous))?.data
        ?.supported_models_detail,
    ).toBeUndefined();
  });

  it('reads the cache again on refresh instead of going back upstream', async () => {
    const filename = await addAccount({}, 'cached-twice');

    await getAccountStatus([filename]);
    const [second] = await getAccountStatus([filename]);

    expect(second?.models).toEqual([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);
    expect(getModelsForCredential).toHaveBeenCalledTimes(1);
  });

  it('goes back upstream on refresh and replaces the cached catalog', async () => {
    const filename = await addAccount({}, 'refreshing');

    await getAccountStatus([filename]);

    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Upstream Two', id: 'upstream-2', vendor: 'e' },
    ]);

    const [refreshed] = await getAccountStatus([filename], { refresh: true });

    expect(getModelsForCredential).toHaveBeenCalledTimes(2);
    expect(refreshed?.models).toEqual([
      { displayName: 'Upstream Two', id: 'upstream-2', vendor: 'e' },
    ]);

    const stored = await findCredentialRecordByFilename(filename);

    // Replaced, not merged: a model upstream dropped is gone from the card.
    expect(getCredentialSupportedModelDetails(stored?.data)).toMatchObject([
      { id: 'upstream-2' },
    ]);
  });

  it('keeps the cached catalog when a refresh comes back empty', async () => {
    const filename = await addAccount({}, 'empty-refresh');

    await getAccountStatus([filename]);

    vi.mocked(getModelsForCredential).mockResolvedValue([]);

    const [refreshed] = await getAccountStatus([filename], { refresh: true });

    // The point of a refresh is to update the cache, not to empty it.
    expect(refreshed?.models).toEqual([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);
  });

  it('keeps the cached catalog when a refresh fails', async () => {
    const filename = await addAccount({}, 'failing-refresh');

    await getAccountStatus([filename]);

    vi.mocked(getModelsForCredential).mockRejectedValue(
      new Error('upstream unreachable'),
    );

    const [refreshed] = await getAccountStatus([filename], { refresh: true });

    expect(refreshed?.models).toEqual([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);
    expect(refreshed?.error).toBeNull();
  });

  it('lets a refresh retry a discovery that is still cooling down', async () => {
    const filename = await addAccount({}, 'cooldown-refresh');

    vi.mocked(getModelsForCredential).mockRejectedValueOnce(
      new Error('upstream unreachable'),
    );

    await getAccountStatus([filename]);

    // A page view would hold off for the rest of the cooldown; the operator
    // pressing Refresh is asking for the call anyway.
    vi.mocked(getModelsForCredential).mockResolvedValue([
      { displayName: 'Recovered', id: 'recovered' },
    ]);

    const [refreshed] = await getAccountStatus([filename], { refresh: true });

    expect(refreshed?.models).toEqual([
      { displayName: 'Recovered', id: 'recovered' },
    ]);
  });

  it('keeps the cached catalog when a refresh has no token to send', async () => {
    const filename = await addAccount({}, 'blank-refresh');

    await getAccountStatus([filename]);

    // The token is gone but the catalog is not: a refresh must not drop the
    // metadata a page load would still show.
    await addCredential(
      { bearer_token: '   ', user_id: 'blank@example.com' },
      filename,
    );

    const stored = await findCredentialRecordByFilename(filename);

    expect(String(stored?.data?.bearer_token ?? '').trim()).toBe('');

    const [refreshed] = await getAccountStatus([filename], { refresh: true });

    expect(getModelsForCredential).toHaveBeenCalledTimes(1);
    expect(refreshed?.models).toEqual([
      { displayName: 'Upstream One', id: 'upstream-1' },
    ]);
  });

  it('leaves the routing whitelist alone on refresh', async () => {
    const filename = await addAccount(
      { supported_models: 'curated-a,curated-b' },
      'curated-refresh',
    );

    await getAccountStatus([filename], { refresh: true });

    const stored = await findCredentialRecordByFilename(filename);

    expect(getCredentialSupportedModels(stored?.data)).toEqual([
      'curated-a',
      'curated-b',
    ]);
  });

  it('withholds a cached campaign until its window opens', async () => {
    const filename = await addAccount(
      {
        supported_models: 'scheduled',
        supported_models_detail: JSON.stringify([
          {
            displayName: 'Scheduled',
            id: 'scheduled',
            promotion: {
              endsAt: '2099-02-01T00:00:00.000Z',
              label: '限时免费',
              startsAt: '2099-01-01T00:00:00.000Z',
            },
          },
        ]),
      },
      'scheduled',
    );

    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));

      const [before] = await getAccountStatus([filename]);

      // Still in the cache — just not running yet.
      expect(before?.models[0]?.promotion).toBeUndefined();

      vi.setSystemTime(new Date('2099-01-02T00:00:00.000Z'));

      const [during] = await getAccountStatus([filename]);

      expect(during?.models[0]?.promotion?.label).toBe('限时免费');

      vi.setSystemTime(new Date('2099-02-02T00:00:00.000Z'));

      const [after] = await getAccountStatus([filename]);

      expect(after?.models[0]?.promotion).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never asks upstream for a credential holding a blank token', async () => {
    const filename = await addAccount({ bearer_token: '   ' }, 'blank');

    const [snapshot] = await getAccountStatus([filename]);

    expect(getModelsForCredential).not.toHaveBeenCalled();
    expect(snapshot.models).toEqual([]);
  });
});
