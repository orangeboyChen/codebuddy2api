import fs from 'node:fs';
import path from 'node:path';

import {
  addCredential,
  findCredentialRecordByFilename,
  findEligibleCredentialRecordByFilename,
  flushCredentialRuntimeState,
  getCredentialProxySettings,
  getCredentialSupportedModelDetails,
  getCredentialSupportedModels,
  listCredentialFilenames,
  listCredentials,
  listEligibleCredentialRecords,
  readCredentialRecords,
  resetCredentialRuntimeState,
  resolveCredentialForRequest,
  updateCredentialSupportedModelCatalog,
  updateCredentialSupportedModelDetail,
  updateCredentialSupportedModels,
} from '@/lib/server/domain/credentials';
import { MODEL_DESCRIPTION_MAX_LENGTH } from '@/lib/server/proxy/codebuddy/model-fields';
import {
  getCredsDir,
  resetStorageRuntime,
  writeStorageJson,
} from '@/lib/server/storage';

const tempRootDir = path.join(process.cwd(), '.tmp-test-credentials-edge');

const cleanup = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
};

describe('credential lifecycle edge cases', () => {
  beforeEach(() => {
    cleanup();
    resetCredentialRuntimeState();
    resetStorageRuntime();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('filters manager metadata and tokenless documents', async () => {
    await writeStorageJson('credentials', 'manager_state.json', {
      globalNextFilename: null,
    });
    await writeStorageJson('credentials', 'tokenless.json', { user_id: 'x' });
    await addCredential(
      { bearer_token: 'token', user_id: 'user@example.com' },
      'valid',
    );

    expect(await listCredentialFilenames()).toEqual(['valid.json']);
    expect(
      (await readCredentialRecords()).every(
        (record) => record.data.bearer_token,
      ),
    ).toBe(true);
  });

  it('honors an explicit credentials directory for isolated runtimes', () => {
    process.env.CODEBUDDY_CREDENTIALS_DIR = '.tmp-explicit-creds';
    expect(getCredsDir()).toBe(path.join(process.cwd(), '.tmp-explicit-creds'));
    delete process.env.CODEBUDDY_CREDENTIALS_DIR;
    expect(getCredsDir()).toBe(path.join(process.cwd(), '.codebuddy_creds'));
  });

  it('normalizes supported models and proxy settings', async () => {
    expect(getCredentialSupportedModels(null)).toEqual([]);
    expect(
      getCredentialSupportedModels({
        supported_models: ' glm-a,glm-b\n glm-a ',
      }),
    ).toEqual(['glm-a', 'glm-b']);
    expect(
      getCredentialProxySettings({ responses_passthrough: true }),
    ).toMatchObject({
      upstreamProtocol: 'responses',
    });
    expect(
      getCredentialProxySettings({
        upstream_protocol: 'chat',
        responses_passthrough: true,
      }),
    ).toMatchObject({
      upstreamProtocol: 'chat',
    });
  });

  it('reads back only well-formed cached model catalogs', () => {
    expect(getCredentialSupportedModelDetails(null)).toEqual([]);
    expect(getCredentialSupportedModelDetails({})).toEqual([]);
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: '   ',
      }),
    ).toEqual([]);
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: 'not json',
      }),
    ).toEqual([]);
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: '{"id":"glm-5.1"}',
      }),
    ).toEqual([]);
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: JSON.stringify([
          { id: ' glm-5.1 ', displayName: 'GLM 5.1', credits: 'x3.33' },
          null,
          'glm-5.1',
          { displayName: 'No id' },
          { id: '   ' },
        ]),
      }),
    ).toEqual([{ credits: 'x3.33', displayName: 'GLM 5.1', id: 'glm-5.1' }]);
  });

  it('keeps one row per model id when the cache repeats an id', () => {
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: JSON.stringify([
          { displayName: 'First', id: 'glm-5.1' },
          { displayName: 'Second', credits: 'x9.99', id: ' glm-5.1 ' },
          { displayName: 'Hy3', id: 'hy3-ioa' },
        ]),
      }),
    ).toEqual([
      { displayName: 'First', id: 'glm-5.1' },
      { displayName: 'Hy3', id: 'hy3-ioa' },
    ]);
  });

  it('keeps cached model details for models a manual edit retains', async () => {
    await expect(
      updateCredentialSupportedModelCatalog('missing.json', []),
    ).rejects.toThrow('Credential is unavailable');

    const created = await addCredential(
      { bearer_token: 'token', user_id: 'user@example.com' },
      'catalog',
    );

    await updateCredentialSupportedModelCatalog(created.filename, [
      { displayName: 'GLM 5.1', id: ' glm-5.1 ', credits: 'x3.33' },
      { displayName: 'GLM 5.1 duplicate', id: 'glm-5.1', credits: 'x3.33' },
      { displayName: 'Dropped', id: '  ' },
      { displayName: 'Hy3', id: 'hy3-ioa', isEnterprise: true },
    ]);
    const stored = await findCredentialRecordByFilename(created.filename);
    expect(stored?.data.supported_models).toBe('glm-5.1,hy3-ioa');
    expect(getCredentialSupportedModelDetails(stored?.data)).toMatchObject([
      { id: 'glm-5.1', credits: 'x3.33' },
      { id: 'hy3-ioa', isEnterprise: true },
    ]);

    await updateCredentialSupportedModels(created.filename, ['glm-5.1', ' ']);
    const pruned = await findCredentialRecordByFilename(created.filename);
    expect(pruned?.data.supported_models).toBe('glm-5.1');
    expect(getCredentialSupportedModelDetails(pruned?.data)).toMatchObject([
      { id: 'glm-5.1', credits: 'x3.33' },
    ]);

    await updateCredentialSupportedModels(created.filename, []);
    expect(
      getCredentialSupportedModelDetails(
        (await findCredentialRecordByFilename(created.filename))?.data,
      ),
    ).toEqual([]);
  });

  it('handles updates for missing and existing credentials', async () => {
    await expect(
      updateCredentialSupportedModels('missing.json', ['glm']),
    ).rejects.toThrow('Credential is unavailable');

    const created = await addCredential(
      {
        bearer_token: 'token',
        created_at: 100,
        responses_passthrough: true,
        user_id: 'user@example.com',
      },
      'existing',
    );
    const updated = await addCredential(
      { bearer_token: 'updated', responses_passthrough: false },
      created.filename,
    );
    expect(updated.filename).toBe(created.filename);
    const record = await findCredentialRecordByFilename(created.filename);
    expect(record?.data.created_at).toBeTypeOf('number');
    expect(record?.data.upstream_protocol).toBe('chat');

    await updateCredentialSupportedModels(created.filename, [
      ' glm-a ',
      'glm-a',
      '',
      'glm-b',
    ]);
    expect(
      (await findCredentialRecordByFilename(created.filename))?.data
        .supported_models,
    ).toBe('glm-a,glm-b');
  });

  it('reports formatted metadata and filters expired or restricted credentials', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await addCredential(
      {
        access_token: 'expired',
        created_at: 1_767_225_590,
        expires_in: 1,
        user_info: { email: 'expired@example.com', name: 'Expired' },
      },
      'expired',
    );
    await addCredential(
      {
        bearer_token: 'valid',
        created_at: 1_767_225_600,
        expires_in: 7200,
        enterpriseId: 'enterprise-1',
        supported_models: 'glm-a,glm-b',
        tenantId: 'tenant-1',
        user_info: { email: 'valid@example.com', name: 'Valid' },
      },
      'valid',
    );

    const listed = await listCredentials();
    expect(listed.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: 'expired.json',
          is_expired: true,
          time_remaining_str: '1m',
        }),
        expect.objectContaining({
          enterprise_id: 'enterprise-1',
          filename: 'valid.json',
          tenant_id: 'tenant-1',
          time_remaining_str: '2h',
        }),
      ]),
    );
    expect(
      (await listEligibleCredentialRecords()).map((record) => record.filename),
    ).toEqual(['valid.json']);
    expect(
      await findEligibleCredentialRecordByFilename('expired.json'),
    ).toBeNull();
    expect(
      await findEligibleCredentialRecordByFilename('valid.json', [
        'other.json',
      ]),
    ).toBeNull();
  });

  it('returns null when no credential matches model or allowlist', async () => {
    await addCredential(
      { bearer_token: 'token', supported_models: 'glm-a' },
      'model-a',
    );
    expect(
      await resolveCredentialForRequest({ model: 'glm-missing' }),
    ).toBeNull();
    expect(
      await resolveCredentialForRequest({
        allowedCredentialFilenames: ['missing.json'],
      }),
    ).toBeNull();
  });

  it('reassigns stale affinity assignments to an eligible credential', async () => {
    const first = await addCredential({ bearer_token: 'first' }, 'first');
    await addCredential({ bearer_token: 'second' }, 'second');
    await writeStorageJson('credentials', 'manager_state.json', {
      affinityAssignmentsByKey: {
        affinity: { credentialFilename: 'missing.json', updatedAt: Date.now() },
      },
    });
    resetCredentialRuntimeState();

    const resolved = await resolveCredentialForRequest({
      affinityKey: 'affinity',
    });
    expect([first.filename, 'second.json']).toContain(resolved?.filename);
    await flushCredentialRuntimeState();
  });

  it('normalizes hand-edited cache entries instead of passing them through', () => {
    // A cache may be written by an older version, or by hand. A non-string
    // field would otherwise reach the card, where `{model.credits}` on an
    // object throws and takes the whole page down.
    expect(
      getCredentialSupportedModelDetails({
        supported_models_detail: JSON.stringify([
          {
            contextWindow: 'huge',
            credits: { multiplier: 1 },
            evil: '<script>alert(1)</script>',
            id: 'g',
            isEnterprise: 'yes',
          },
          { id: 'h' },
        ]),
      }),
    ).toEqual([
      { displayName: 'g', id: 'g' },
      { displayName: 'h', id: 'h' },
    ]);
  });

  it('truncates a long model description before caching it', async () => {
    const created = await addCredential({ bearer_token: 'token' }, 'described');

    await updateCredentialSupportedModelCatalog(created.filename, [
      {
        descriptionEn: 'x'.repeat(4000),
        descriptionZh: 'y'.repeat(4000),
        displayName: 'Verbose',
        id: 'verbose',
      },
    ]);

    const stored = await findCredentialRecordByFilename(created.filename);
    const [model] = getCredentialSupportedModelDetails(stored?.data);

    expect(model?.descriptionEn).toHaveLength(MODEL_DESCRIPTION_MAX_LENGTH);
    expect(model?.descriptionZh).toHaveLength(MODEL_DESCRIPTION_MAX_LENGTH);
  });

  it('caps the cached catalog so a verbose upstream cannot balloon a credential', async () => {
    const created = await addCredential({ bearer_token: 'token' }, 'verbose');
    const verboseDescription = 'x'.repeat(4000);

    await updateCredentialSupportedModelCatalog(
      created.filename,
      Array.from({ length: 400 }, (_, index) => ({
        descriptionEn: verboseDescription,
        descriptionZh: verboseDescription,
        displayName: `Model ${index}`,
        id: `model-${index}`,
      })),
    );

    const stored = await findCredentialRecordByFilename(created.filename);
    const raw = String(stored?.data.supported_models_detail ?? '');

    // 400 described models is roughly 400KB. The credential document is
    // re-encrypted in full on every write, so the cache drops descriptions
    // and keeps the ids that routing and the card both need.
    expect(raw).not.toContain(verboseDescription);
    expect(raw.length).toBeLessThan(256 * 1024);
    expect(getCredentialSupportedModelDetails(stored?.data)).toHaveLength(400);
  });

  it('caches details without rewriting the routing whitelist', async () => {
    const created = await addCredential(
      { bearer_token: 'token', supported_models: 'curated-a' },
      'detail-only',
    );

    await updateCredentialSupportedModelDetail(created.filename, [
      { displayName: 'Upstream One', id: ' upstream-1 ' },
      { displayName: 'Blank', id: '   ' },
    ]);

    // `supported_models` is what `resolveCredentialForRequest` routes by, so
    // only the explicit refresh and manual-edit paths may write it.
    const stored = await findCredentialRecordByFilename(created.filename);
    expect(stored?.data.supported_models).toBe('curated-a');
    expect(getCredentialSupportedModelDetails(stored?.data)).toMatchObject([
      { id: 'upstream-1' },
    ]);
  });
});
