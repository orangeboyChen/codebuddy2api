import {
  deploymentSignIn,
  probeDeployment,
} from '@/lib/server/electron/deployment';

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

describe('deploymentSignIn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answered = (
    session: unknown,
    init: { ok?: boolean } = {},
  ): typeof fetch =>
    vi.fn(async () => ({
      json: async () => ({ session }),
      ok: init.ok ?? true,
    })) as unknown as typeof fetch;

  it('says the console is ready for a deployment this app is signed in to', async () => {
    vi.stubGlobal(
      'fetch',
      answered({ accountConfigured: true, authenticated: true }),
    );

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it('asks no more of a console that has no account to sign in to', async () => {
    vi.stubGlobal(
      'fetch',
      answered({ accountConfigured: false, authenticated: false }),
    );

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'ready' });
  });

  it('sends the token it holds, so the answer is about that token', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ session: { authenticated: true } }),
      ok: true,
    })) as unknown as typeof fetch;

    vi.stubGlobal('fetch', fetchImpl);

    await deploymentSignIn({
      deviceToken: 'token-the-browser-brought-back',
      url: 'https://codebuddy.example.com',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://codebuddy.example.com/admin-api/auth/session',
      expect.objectContaining({
        headers: { authorization: 'Bearer token-the-browser-brought-back' },
      }),
    );
  });

  /**
   * A token is good for thirty days and is kept here without one, so a dead one
   * is still a token: asked about rather than assumed, which is what sends a
   * run-out token back to the window that signs this app in instead of on to
   * the deployment's own login page.
   */
  it('asks for a sign-in when the deployment refuses the token it holds', async () => {
    vi.stubGlobal(
      'fetch',
      answered({ accountConfigured: true, authenticated: false }),
    );

    await expect(
      deploymentSignIn({
        deviceToken: 'a-token-that-ran-out',
        url: 'https://codebuddy.example.com',
      }),
    ).resolves.toEqual({ kind: 'needsSignIn' });
  });

  it('asks for a sign-in when there is no token at all', async () => {
    vi.stubGlobal(
      'fetch',
      answered({ accountConfigured: true, authenticated: false }),
    );

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'needsSignIn' });
  });

  it('claims nothing about a deployment that did not answer', async () => {
    vi.stubGlobal('fetch', answered({}, { ok: false }));

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'unknown' });
  });

  it('claims nothing about an answer with no session in it', async () => {
    vi.stubGlobal('fetch', answered(undefined));

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'unknown' });
  });

  it('claims nothing about a deployment that does not answer at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    );

    await expect(
      deploymentSignIn({ url: 'https://codebuddy.example.com' }),
    ).resolves.toEqual({ kind: 'unknown' });
  });
});
