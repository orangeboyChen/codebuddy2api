import { probeDeployment } from '@/lib/server/electron/deployment';

const respondWith = (
  body: () => Promise<unknown>,
  init: { ok?: boolean } = {},
): typeof fetch =>
  vi.fn(async () => ({
    json: body,
    ok: init.ok ?? true,
  })) as unknown as typeof fetch;

describe('probeDeployment', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts a deployment of this app', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(async () => ({
        service: 'codebuddy2api',
        status: 'healthy',
      })),
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it('asks the deployment’s own health, and not the console', async () => {
    const fetchImpl = respondWith(async () => ({
      service: 'codebuddy2api',
    }));
    vi.stubGlobal('fetch', fetchImpl);

    await probeDeployment({ url: 'https://codebuddy.example.com/console' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://codebuddy.example.com/health',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('accepts a deployment that answers an error, when the error is its own', async () => {
    // An unhealthy storage makes `/health` answer 503, still naming this app.
    // Refusing it on the status alone would claim the address is not a
    // deployment of this app — the one thing it certainly is.
    vi.stubGlobal(
      'fetch',
      respondWith(
        async () => ({ service: 'codebuddy2api', status: 'unhealthy' }),
        { ok: false },
      ),
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it.each([
    {
      payload: { service: 'something-else' },
      why: 'another service’s health',
    },
    { payload: {}, why: 'a health answer naming nothing' },
    { payload: [], why: 'a list of health answers' },
    { payload: 'healthy', why: 'a health answer that is not an object' },
  ])('refuses $why', async ({ payload }) => {
    vi.stubGlobal(
      'fetch',
      respondWith(async () => payload),
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'foreign' });
  });

  it('refuses an answer that is not json', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(async () => {
        throw new Error('unexpected token <');
      }),
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'foreign' });
  });

  it('refuses a host that answers with an error and does not name itself', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith(async () => ({ error: 'Service Unavailable' }), {
        ok: false,
      }),
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'foreign' });
  });

  it('reports a host that does not answer at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    );

    await expect(
      probeDeployment({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'unreachable' });
  });

  it('gives up on a host that hangs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ) as unknown as typeof fetch,
    );

    await expect(
      probeDeployment({
        timeoutMs: 5,
        url: 'https://codebuddy.example.com',
      }),
    ).resolves.toEqual({ kind: 'unreachable' });
  });
});
