import { getForwardedHeaderValue } from '@/lib/server/shared/http';

const makeHeaders = (values: Record<string, string>): Headers => {
  return new Headers(values);
};

describe('forwarded header parsing', () => {
  it('returns null when the header is absent', () => {
    expect(
      getForwardedHeaderValue(makeHeaders({}), 'x-forwarded-proto'),
    ).toBeNull();
  });

  it('takes the first entry of a chain and trims it', () => {
    expect(
      getForwardedHeaderValue(
        makeHeaders({
          'x-forwarded-host': 'admin.example.com, proxy.internal',
        }),
        'x-forwarded-host',
      ),
    ).toBe('admin.example.com');
  });

  it('returns null when the first entry is empty', () => {
    // A chain that starts with a comma has no client entry to trust, so the
    // caller has to fall back rather than use an empty host.
    expect(
      getForwardedHeaderValue(
        makeHeaders({ 'x-forwarded-host': ', proxy.internal' }),
        'x-forwarded-host',
      ),
    ).toBeNull();
    expect(
      getForwardedHeaderValue(
        makeHeaders({ 'x-forwarded-host': '   ' }),
        'x-forwarded-host',
      ),
    ).toBeNull();
  });
});

describe('request origin resolution', () => {
  const fallback = { host: 'localhost', protocol: 'http' };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.CODEBUDDY_ADMIN_TRUST_PROXY;
  });

  const mockConfig = (trustProxy: boolean | (() => never)): void => {
    vi.doMock('@/lib/server/domain/config', () => ({
      getActiveConfig: async () => {
        if (typeof trustProxy === 'function') {
          trustProxy();
        }

        return { CODEBUDDY_ADMIN_TRUST_PROXY: trustProxy };
      },
    }));
  };

  it('uses the forwarded headers when the proxy is trusted', async () => {
    mockConfig(true);
    const { resolveRequestOrigin: resolve } =
      await import('@/lib/server/shared/http');

    await expect(
      resolve(
        makeHeaders({
          'x-forwarded-host': 'admin.example.com, proxy.internal',
          'x-forwarded-proto': 'https, http',
        }),
        fallback,
      ),
    ).resolves.toEqual({ host: 'admin.example.com', protocol: 'https' });
  });

  it('ignores the forwarded headers when no proxy is trusted', async () => {
    mockConfig(false);
    const { resolveRequestOrigin: resolve } =
      await import('@/lib/server/shared/http');

    await expect(
      resolve(
        makeHeaders({
          'x-forwarded-host': 'evil.example.com',
          'x-forwarded-proto': 'http',
          host: 'admin.example.com',
        }),
        fallback,
      ),
    ).resolves.toEqual({ host: 'admin.example.com', protocol: 'http' });
  });

  it('falls back when the forwarded host is not a usable origin', async () => {
    mockConfig(true);
    const { resolveRequestOrigin: resolve } =
      await import('@/lib/server/shared/http');

    // A client can put anything in this header, and a page that builds a URL
    // from it must not throw.
    await expect(
      resolve(
        makeHeaders({
          'x-forwarded-host': 'not a host',
          'x-forwarded-proto': 'https',
        }),
        fallback,
      ),
    ).resolves.toEqual(fallback);
  });

  it('keeps the documented default when the config cannot be read', async () => {
    mockConfig(() => {
      throw new Error('storage unavailable');
    });
    const { resolveRequestOrigin: resolve } =
      await import('@/lib/server/shared/http');

    await expect(
      resolve(
        makeHeaders({
          'x-forwarded-proto': 'https',
          host: 'admin.example.com',
        }),
        fallback,
      ),
    ).resolves.toEqual({ host: 'admin.example.com', protocol: 'https' });
  });
});
