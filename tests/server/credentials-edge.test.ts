import fs from 'node:fs';
import path from 'node:path';

import {
  addCredential,
  findCredentialRecordByFilename,
  findEligibleCredentialRecordByFilename,
  flushCredentialRuntimeState,
  getCredentialProxySettings,
  getCredentialSupportedModels,
  listCredentialFilenames,
  listCredentials,
  listEligibleCredentialRecords,
  readCredentialRecords,
  resetCredentialRuntimeState,
  resolveCredentialForRequest,
  updateCredentialSupportedModels,
} from '@/lib/server/domain/credentials';
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
});
