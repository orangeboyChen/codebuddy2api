import {
  fetchServerVersion,
  serverVersionFromPayload,
} from '@/lib/server/electron/version';

const respondWith = (
  body: () => Promise<unknown>,
  init: { ok?: boolean } = {},
): typeof fetch =>
  vi.fn(async () => ({
    json: body,
    ok: init.ok ?? true,
  })) as unknown as typeof fetch;

describe('serverVersionFromPayload', () => {
  it('reads the version', () => {
    expect(serverVersionFromPayload({ version: '1.3.15' })).toBe('1.3.15');
  });

  it('reads around the whitespace', () => {
    expect(serverVersionFromPayload({ version: '  1.3.15  ' })).toBe('1.3.15');
  });

  it.each([
    { payload: null, why: 'null' },
    { payload: '1.3.15', why: 'a bare string' },
    { payload: [], why: 'an array' },
    { payload: {}, why: 'an object with no version' },
    { payload: { version: 1.3 }, why: 'a version that is not a string' },
    { payload: { version: '   ' }, why: 'a version that is only whitespace' },
  ])('has no version for $why', ({ payload }) => {
    expect(serverVersionFromPayload(payload)).toBeNull();
  });
});

describe('fetchServerVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the deployment it was given', async () => {
    const fetchImpl = respondWith(async () => ({ version: '1.3.15' }));
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      fetchServerVersion({
        baseUrl: 'https://codebuddy.example.com',
        cookie: 'session=abc',
      }),
    ).resolves.toBe('1.3.15');

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://codebuddy.example.com/admin-api/version',
      expect.objectContaining({ headers: { cookie: 'session=abc' } }),
    );
  });

  it('sends no cookie header when it has no session', async () => {
    const fetchImpl = respondWith(async () => ({ version: '1.3.15' }));
    vi.stubGlobal('fetch', fetchImpl);

    await fetchServerVersion({ baseUrl: 'https://codebuddy.example.com' });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: {} }),
    );
  });

  it('gives up rather than wait forever', async () => {
    const fetchImpl = respondWith(async () => ({ version: '1.3.15' }));
    vi.stubGlobal('fetch', fetchImpl);

    await fetchServerVersion({ baseUrl: 'https://codebuddy.example.com' });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    { ok: false, why: 'a sign-in it does not have' },
    { ok: true, why: 'a payload that names no version' },
  ])('has no version for $why', async ({ ok }) => {
    vi.stubGlobal(
      'fetch',
      respondWith(async () => (ok ? {} : { version: '1.3.15' }), { ok }),
    );

    await expect(
      fetchServerVersion({ baseUrl: 'https://codebuddy.example.com' }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      why: 'a deployment that is not answering',
      fetchImpl: () => {
        throw new Error('offline');
      },
    },
    {
      why: 'a deployment that answers with something unreadable',
      fetchImpl: async () => ({
        json: async () => {
          throw new Error('not json');
        },
        ok: true,
      }),
    },
  ])('has no version for $why', async ({ fetchImpl }) => {
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    await expect(
      fetchServerVersion({ baseUrl: 'https://codebuddy.example.com' }),
    ).resolves.toBeNull();
  });
});
