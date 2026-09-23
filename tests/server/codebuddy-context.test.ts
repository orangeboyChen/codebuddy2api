import { NextRequest } from 'next/server';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CredentialData,
  CredentialRecord,
} from '@/lib/server/domain/credentials';

/**
 * The credential lookup half of a proxy turn.
 *
 * `resolveRequestAccessKey` and `resolveCredentialForRequest` are mocked: they
 * are storage-facing and already covered against real storage elsewhere, and
 * what is under test here is what `context.ts` does with what they return —
 * the affinity key it derives, and the errors it raises for the two ways a
 * turn can have no credential to run on.
 */
vi.mock('@/lib/server/proxy/auth', () => ({
  resolveRequestAccessKey: vi.fn(),
}));
vi.mock('@/lib/server/domain/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/domain/credentials')>()),
  findCredentialRecordByFilename: vi.fn(),
  findEligibleCredentialRecordByFilename: vi.fn(),
  resolveCredentialForRequest: vi.fn(),
}));

const { resolveRequestAccessKey } = await import('@/lib/server/proxy/auth');
const {
  findCredentialRecordByFilename,
  findEligibleCredentialRecordByFilename,
  resolveCredentialForRequest,
} = await import('@/lib/server/domain/credentials');
const {
  createProxyContextFromCredential,
  getCredentialAffinityKey,
  getCredentialValue,
  resolveProxyContext,
  resolveProxyContextByCredentialFilename,
} = await import('@/lib/server/proxy/codebuddy/context');

const credentialRecord = (
  data: Record<string, unknown>,
  filename = 'credential.json',
): CredentialRecord => ({
  data: data as CredentialData,
  filePath: `/tmp/${filename}`,
  filename,
});

const makeRequest = (
  headers?: Record<string, string>,
  url = 'http://localhost/v1/chat/completions',
): NextRequest => new NextRequest(url, { headers, method: 'POST' });

describe('getCredentialAffinityKey', () => {
  it('is undefined without a conversation id', () => {
    expect(getCredentialAffinityKey(makeRequest(), null)).toBeUndefined();
  });

  it('is undefined for a conversation id that is only whitespace', () => {
    const request = makeRequest({ 'x-conversation-id': '   ' });

    expect(getCredentialAffinityKey(request, 'key-1')).toBeUndefined();
  });

  it('scopes the conversation to the access key when there is one', () => {
    const request = makeRequest({ 'x-conversation-id': ' conv-1 ' });

    expect(getCredentialAffinityKey(request, 'key-1')).toBe(
      'access-key:key-1:conversation:conv-1',
    );
  });

  it('scopes the conversation globally when no access key is bound', () => {
    const request = makeRequest({ 'x-conversation-id': 'conv-2' });

    expect(getCredentialAffinityKey(request, null)).toBe(
      'global:conversation:conv-2',
    );
  });
});

describe('getCredentialValue', () => {
  it('returns null for a value that is not an object', () => {
    expect(getCredentialValue(null, ['domain'])).toBeNull();
    expect(getCredentialValue(undefined, ['domain'])).toBeNull();
    expect(getCredentialValue('workbuddy.ai', ['domain'])).toBeNull();
    expect(getCredentialValue(42, ['domain'])).toBeNull();
    expect(getCredentialValue(true, ['domain'])).toBeNull();
  });

  it('reads a candidate key straight off the object', () => {
    expect(getCredentialValue({ domain: 'acme.ai' }, ['domain'])).toBe(
      'acme.ai',
    );
  });

  it('prefers the first candidate key that carries a value', () => {
    const value = { enterpriseId: 'fallback', enterprise_id: 'canonical' };

    expect(getCredentialValue(value, ['enterprise_id', 'enterpriseId'])).toBe(
      'canonical',
    );
  });

  it('skips a candidate key that is present but empty', () => {
    const value = { enterprise_id: '', enterpriseId: 'fallback' };

    expect(getCredentialValue(value, ['enterprise_id', 'enterpriseId'])).toBe(
      'fallback',
    );
    expect(getCredentialValue({ domain: null }, ['domain'])).toBeNull();
    expect(getCredentialValue({ domain: undefined }, ['domain'])).toBeNull();
  });

  it('keeps a zero, which is falsy but not absent', () => {
    expect(getCredentialValue({ tenant_id: 0 }, ['tenant_id'])).toBe(0);
  });

  it('descends into nested objects', () => {
    const value = { user_info: { profile: { tenant_id: 'nested-tenant' } } };

    expect(getCredentialValue(value, ['tenant_id', 'tenantId'])).toBe(
      'nested-tenant',
    );
  });

  it('returns null when no nested object carries a candidate key', () => {
    const value = { user_info: { profile: { other: 'x' } }, unrelated: 1 };

    expect(getCredentialValue(value, ['tenant_id'])).toBeNull();
  });

  it('reads the first array item that carries a candidate key', () => {
    const value = [{ other: 'x' }, { tenant_id: 'second' }, { tenant_id: 3 }];

    expect(getCredentialValue(value, ['tenant_id'])).toBe('second');
  });

  it('descends into an array held by an object', () => {
    const value = { items: [{ enterprise_id: 'in-array' }] };

    expect(getCredentialValue(value, ['enterprise_id'])).toBe('in-array');
  });

  it('skips array items that are empty or not objects', () => {
    expect(getCredentialValue([null, 7, 'x', []], ['domain'])).toBeNull();
    expect(
      getCredentialValue([{ domain: '' }, { domain: 'later.ai' }], ['domain']),
    ).toBe('later.ai');
  });

  it('returns null for an empty array', () => {
    expect(getCredentialValue([], ['domain'])).toBeNull();
  });
});

describe('createProxyContextFromCredential', () => {
  it('throws when the credential carries no token', () => {
    expect(() =>
      createProxyContextFromCredential(credentialRecord({})),
    ).toThrow('Saved credential does not include a bearer token');
  });

  it('leaves the access key unbound', () => {
    const context = createProxyContextFromCredential(
      credentialRecord({ bearer_token: 'token', user_id: 'u@example.test' }),
    );

    expect(context.accessKeyId).toBeNull();
    expect(context.accessKeyName).toBeNull();
    expect(context.auth.bearerToken).toBe('token');
  });
});

describe('resolveProxyContextByCredentialFilename', () => {
  beforeEach(() => {
    vi.mocked(findCredentialRecordByFilename).mockResolvedValue(null);
    vi.mocked(findEligibleCredentialRecordByFilename).mockResolvedValue(null);
  });

  it('throws when the selected credential is gone', async () => {
    await expect(
      resolveProxyContextByCredentialFilename('gone.json'),
    ).rejects.toThrow('Selected credential was not found');
    expect(findCredentialRecordByFilename).toHaveBeenCalledWith('gone.json');
    expect(findEligibleCredentialRecordByFilename).not.toHaveBeenCalled();
  });

  it('looks the credential up without an eligibility check by default', async () => {
    vi.mocked(findCredentialRecordByFilename).mockResolvedValue(
      credentialRecord({ bearer_token: 'token' }, 'a.json') as never,
    );

    const context = await resolveProxyContextByCredentialFilename('a.json');

    expect(context.credentialFilename).toBe('a.json');
    expect(context.accessKeyId).toBeNull();
  });

  it('checks eligibility when the caller asks for it', async () => {
    vi.mocked(findEligibleCredentialRecordByFilename).mockResolvedValue(
      credentialRecord({ bearer_token: 'token' }, 'b.json') as never,
    );

    const context = await resolveProxyContextByCredentialFilename('b.json', {
      accessKey: { id: 'key-3', name: 'team-c' },
      allowedCredentialFilenames: ['b.json'],
      requireEligible: true,
    });

    expect(findEligibleCredentialRecordByFilename).toHaveBeenCalledWith(
      'b.json',
      ['b.json'],
    );
    expect(findCredentialRecordByFilename).not.toHaveBeenCalled();
    expect(context.accessKeyId).toBe('key-3');
    expect(context.accessKeyName).toBe('team-c');
  });

  it('throws when an eligible lookup finds no credential', async () => {
    await expect(
      resolveProxyContextByCredentialFilename('b.json', {
        requireEligible: true,
      }),
    ).rejects.toThrow('Selected credential was not found');
  });
});

describe('resolveProxyContext', () => {
  beforeEach(() => {
    vi.mocked(resolveRequestAccessKey).mockResolvedValue(null);
    vi.mocked(resolveCredentialForRequest).mockResolvedValue(null);
  });

  it('throws when no credential is eligible', async () => {
    await expect(resolveProxyContext(makeRequest())).rejects.toThrow(
      'No valid CodeBuddy credentials found',
    );
  });

  it('forwards the access key, the affinity key and the model', async () => {
    vi.mocked(resolveRequestAccessKey).mockResolvedValue({
      credentialFilenames: ['credential.json'],
      id: 'key-1',
      name: 'team-a',
    } as never);

    const request = makeRequest({ 'x-conversation-id': 'conv-9' });

    await expect(resolveProxyContext(request, 'glm-5.1')).rejects.toThrow();

    expect(resolveCredentialForRequest).toHaveBeenCalledWith({
      accessKeyId: 'key-1',
      affinityKey: 'access-key:key-1:conversation:conv-9',
      allowedCredentialFilenames: ['credential.json'],
      model: 'glm-5.1',
    });
  });

  it('throws when the credential carries no token', async () => {
    vi.mocked(resolveCredentialForRequest).mockResolvedValue(
      credentialRecord({ user_id: 'someone@example.test' }) as never,
    );

    await expect(resolveProxyContext(makeRequest())).rejects.toThrow(
      'Saved credential does not include a bearer token',
    );
  });

  it('throws when the token is only whitespace', async () => {
    vi.mocked(resolveCredentialForRequest).mockResolvedValue(
      credentialRecord({ bearer_token: '   ' }) as never,
    );

    await expect(resolveProxyContext(makeRequest())).rejects.toThrow(
      'Saved credential does not include a bearer token',
    );
  });

  it('falls back to an access token and trims it', async () => {
    vi.mocked(resolveCredentialForRequest).mockResolvedValue(
      credentialRecord({ access_token: '  access-token  ' }) as never,
    );

    const context = await resolveProxyContext(makeRequest());

    expect(context.auth.bearerToken).toBe('access-token');
    expect(context.auth.userId).toBe('unknown');
    expect(context.credentialFilename).toBe('credential.json');
  });

  it('builds the context an upstream call needs', async () => {
    vi.mocked(resolveRequestAccessKey).mockResolvedValue({
      credentialFilenames: null,
      id: 'key-2',
      name: 'team-b',
    } as never);
    vi.mocked(resolveCredentialForRequest).mockResolvedValue(
      credentialRecord(
        {
          bearer_token: 'bearer-token',
          responses_passthrough: true,
          user_id: 'someone@example.test',
        },
        'team-b.json',
      ) as never,
    );

    const context = await resolveProxyContext(makeRequest());

    expect(context).toEqual({
      accessKeyId: 'key-2',
      accessKeyName: 'team-b',
      auth: {
        bearerToken: 'bearer-token',
        credentialData: {
          bearer_token: 'bearer-token',
          responses_passthrough: true,
          user_id: 'someone@example.test',
        },
        type: 'bearer',
        userId: 'someone@example.test',
      },
      credentialFilename: 'team-b.json',
      preferences: {
        firstMessageRoleToSystem: false,
        firstSystemMessageRoleToUser: false,
        upstreamProtocol: 'responses',
      },
    });
  });
});
