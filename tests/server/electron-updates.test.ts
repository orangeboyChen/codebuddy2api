import {
  HOME_PAGE_URL,
  LATEST_API_URL,
  LATEST_RELEASE_URL,
  RELEASES_PAGE_URL,
  assetDownloadUrl,
  assetNames,
  checkForUpdate,
  compareVersions,
  fetchLatestRelease,
  findReleaseAsset,
  parseVersion,
  releasePageUrl,
  tagFromReleasePage,
  type ReleaseFetch,
  type ReleaseResponse,
} from '@/lib/server/electron/updates';

const TAG_PAGE =
  'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.4.0';

const headersOf = (
  values: Record<string, string | null>,
): ReleaseResponse['headers'] => ({
  get: (name) => values[name.toLowerCase()] ?? null,
});

/** The answer to a request for the release page that redirects to a release. */
const pageResponse = (url: string, location = ''): ReleaseResponse => ({
  headers: headersOf({ location }),
  json: async () => null,
  ok: true,
  url,
});

/** The answer to a request for one file of one release. */
const fileResponse = (ok: boolean, size?: number): ReleaseResponse => ({
  headers: headersOf({
    'content-length': size === undefined ? null : String(size),
  }),
  json: async () => null,
  ok,
  url: 'https://objects.githubusercontent.com/example',
});

const apiResponse = (payload: unknown, ok = true): ReleaseResponse => ({
  headers: headersOf({}),
  json: async () => payload,
  ok,
  url: LATEST_API_URL,
});

/**
 * GitHub as the app sees it: the page that redirects to the newest release,
 * the files a release holds, and the API behind both.
 */
const githubFetch = ({
  assets = ['CodeBuddy2API-1.4.0-mac-arm64.dmg'],
  ok = true,
  tagPage = TAG_PAGE,
}: {
  assets?: string[];
  ok?: boolean;
  /** Where `/releases/latest` lands. Empty when it answers nothing. */
  tagPage?: string;
} = {}): ReleaseFetch =>
  vi.fn(async (url: string) => {
    if (url === LATEST_RELEASE_URL) {
      return pageResponse(tagPage || LATEST_RELEASE_URL);
    }

    if (url === LATEST_API_URL) {
      return apiResponse({ tag_name: 'v1.4.0' }, ok);
    }

    return fileResponse(assets.some((name) => url.endsWith(`/${name}`)));
  }) as unknown as ReleaseFetch;

/** A network that is not there. */
const offlineFetch = (): ReleaseFetch =>
  vi.fn(async () => {
    throw new Error('offline');
  }) as unknown as ReleaseFetch;

describe('parseVersion', () => {
  it.each([
    { value: '1.3.15', why: 'a release version' },
    { value: 'v1.3.15', why: 'a tag' },
    { value: '1.4', why: 'two parts' },
    { value: '2', why: 'one part' },
    { value: '1.4.0-beta.1', why: 'a pre-release' },
  ])('reads $why', ({ value }) => {
    expect(parseVersion(value)).not.toBeNull();
  });

  it.each([
    { value: '', why: 'nothing' },
    { value: 'next', why: 'not a number' },
    { value: '1.3.x', why: 'a letter inside' },
    { value: 1.3, why: 'a number' },
    { value: null, why: 'null' },
  ])('rejects $why', ({ value }) => {
    expect(parseVersion(value)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders releases by number', () => {
    expect(compareVersions('1.4.0', '1.3.15')).toBeGreaterThan(0);
    expect(compareVersions('1.3.15', '1.4.0')).toBeLessThan(0);
    expect(compareVersions('1.3.15', '1.3.15')).toBe(0);
  });

  it('compares parts a shorter version leaves out as zero', () => {
    expect(compareVersions('1.4', '1.4.0')).toBe(0);
    expect(compareVersions('1.4.1', '1.4')).toBeGreaterThan(0);
  });

  // A release candidate for 1.4.0 is older than 1.4.0 itself, which is what
  // makes "is there something newer" safe to answer with it.
  it('calls a pre-release older than the release it leads to', () => {
    expect(compareVersions('1.4.0-beta.1', '1.4.0')).toBeLessThan(0);
    expect(compareVersions('1.4.0', '1.4.0-rc.1')).toBeGreaterThan(0);
  });

  it.each([
    { left: '1.3.15', right: 'not-a-version' },
    { left: 'next', right: '1.3.15' },
  ])('refuses to compare $left with $right', ({ left, right }) => {
    expect(compareVersions(left, right)).toBeNull();
  });
});

describe('tagFromReleasePage', () => {
  it('reads the tag out of the page it was redirected to', () => {
    expect(tagFromReleasePage(TAG_PAGE)).toBe('v1.4.0');
  });

  it('reads a tag that had to be escaped to travel in a URL', () => {
    expect(
      tagFromReleasePage(
        'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.4.0%2Bbuild',
      ),
    ).toBe('v1.4.0+build');
  });

  it('reads a tag whose escape is broken rather than none at all', () => {
    expect(
      tagFromReleasePage(
        'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.4%',
      ),
    ).toBe('v1.4%');
  });

  it.each([
    { url: LATEST_RELEASE_URL, why: 'the page a release is asked for' },
    { url: RELEASES_PAGE_URL, why: 'the list of every release' },
    { url: '', why: 'nothing' },
  ])('is not a tag for $why', ({ url }) => {
    expect(tagFromReleasePage(url)).toBeNull();
  });
});

describe('assetNames', () => {
  it('names the disk image built for this Mac', () => {
    expect(assetNames('1.4.0', 'darwin', 'arm64')).toEqual([
      'CodeBuddy2API-1.4.0-mac-arm64.dmg',
    ]);
  });

  it('offers the installer before the portable build on Windows', () => {
    expect(assetNames('1.4.0', 'win32', 'x64')).toEqual([
      'CodeBuddy2API-1.4.0-win-x64-setup.exe',
      'CodeBuddy2API-1.4.0-win-x64-portable.exe',
    ]);
  });

  it('offers the AppImage before the package on Linux', () => {
    expect(assetNames('1.4.0', 'linux', 'x64')).toEqual([
      'CodeBuddy2API-1.4.0-linux-x64.AppImage',
      'codebuddy2api-1.4.0-linux-x64.deb',
    ]);
  });

  it('has nothing to name for a platform the app is not built for', () => {
    expect(assetNames('1.4.0', 'aix', 'x64')).toEqual([]);
  });
});

describe('release and asset URLs', () => {
  it('points at the release GitHub published under that tag', () => {
    expect(releasePageUrl('v1.4.0')).toBe(
      `${HOME_PAGE_URL}/releases/tag/v1.4.0`,
    );
  });

  it('points at one file inside that release', () => {
    expect(
      assetDownloadUrl('v1.4.0', 'CodeBuddy2API-1.4.0-mac-arm64.dmg'),
    ).toBe(
      `${HOME_PAGE_URL}/releases/download/v1.4.0/CodeBuddy2API-1.4.0-mac-arm64.dmg`,
    );
  });

  it('escapes a name that would otherwise change the path', () => {
    expect(assetDownloadUrl('v1.4.0', 'a b.dmg')).toContain('a%20b.dmg');
  });
});

describe('fetchLatestRelease', () => {
  it('reads the newest release off the page GitHub redirects to', async () => {
    await expect(
      fetchLatestRelease({ fetchImpl: githubFetch() }),
    ).resolves.toEqual({
      tag: 'v1.4.0',
      url: releasePageUrl('v1.4.0'),
      version: '1.4.0',
    });
  });

  // A runtime that hands the 302 back rather than following it still says
  // where it points.
  it('reads the release out of a redirect it was handed instead', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === LATEST_RELEASE_URL
        ? pageResponse(LATEST_RELEASE_URL, TAG_PAGE)
        : apiResponse({ tag_name: 'v1.4.0' }),
    ) as unknown as ReleaseFetch;

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toMatchObject({
      tag: 'v1.4.0',
    });
  });

  // A different host answering the same question: worth trying when the page
  // could not say, because one of the two is what a network usually blocks.
  it('falls back to the API when the page names nothing', async () => {
    const fetchImpl = githubFetch({ tagPage: '' });

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toMatchObject({
      tag: 'v1.4.0',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      LATEST_API_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': expect.any(String) }),
      }),
    );
  });

  it.each([
    {
      build: () => githubFetch({ ok: false, tagPage: '' }),
      why: 'an API that refuses to answer',
    },
    {
      build: () =>
        vi.fn(async () =>
          pageResponse(LATEST_RELEASE_URL),
        ) as unknown as ReleaseFetch,
      why: 'a page and an API that name nothing',
    },
  ])('answers nothing for $why', async ({ build }) => {
    await expect(
      fetchLatestRelease({ fetchImpl: build() }),
    ).resolves.toBeNull();
  });

  it('answers nothing for a network that is not there', async () => {
    await expect(
      fetchLatestRelease({ fetchImpl: offlineFetch() }),
    ).resolves.toBeNull();
  });

  // The fallback is only worth having because the page may be the thing that
  // hangs: a wait it ran out on must not be the wait the API gets too, or the
  // request is aborted before it is ever made.
  it('gives the API a wait of its own when the page ran the shared one out', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = vi.fn(
      async (url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);

        return url === LATEST_RELEASE_URL
          ? pageResponse(LATEST_RELEASE_URL)
          : apiResponse({ tag_name: 'v1.4.0' });
      },
    ) as unknown as ReleaseFetch;

    await expect(
      fetchLatestRelease({ fetchImpl, signal: AbortSignal.abort() }),
    ).resolves.toMatchObject({ tag: 'v1.4.0' });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  // A caller's own wait is honoured still: it is what a cancelled check is.
  it('waits on the caller’s signal when there is time left in it', async () => {
    const signal = AbortSignal.timeout(60_000);
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = vi.fn(
      async (url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);

        return url === LATEST_RELEASE_URL
          ? pageResponse(LATEST_RELEASE_URL)
          : apiResponse({ tag_name: 'v1.4.0' });
      },
    ) as unknown as ReleaseFetch;

    await expect(
      fetchLatestRelease({ fetchImpl, signal }),
    ).resolves.toMatchObject({ tag: 'v1.4.0' });

    expect(signals[1]).toBe(signal);
  });

  // A tag that is not a version is published all the same, but there is
  // nothing to compare a build against.
  it('reports no version for a tag that is not one', async () => {
    const fetchImpl = githubFetch({
      tagPage:
        'https://github.com/orangeboyChen/codebuddy2api/releases/tag/nightly',
    });

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toMatchObject({
      tag: 'nightly',
      version: null,
    });
  });
});

describe('findReleaseAsset', () => {
  it('answers with the file this machine wants', async () => {
    await expect(
      findReleaseAsset({
        arch: 'arm64',
        fetchImpl: githubFetch(),
        platform: 'darwin',
        tag: 'v1.4.0',
        version: '1.4.0',
      }),
    ).resolves.toEqual({
      asset: {
        name: 'CodeBuddy2API-1.4.0-mac-arm64.dmg',
        size: 0,
        url: assetDownloadUrl('v1.4.0', 'CodeBuddy2API-1.4.0-mac-arm64.dmg'),
      },
      kind: 'found',
    });
  });

  it('reads how big the file is out of the answer', async () => {
    const fetchImpl = vi.fn(async () =>
      fileResponse(true, 1_000),
    ) as unknown as ReleaseFetch;

    await expect(
      findReleaseAsset({ fetchImpl, tag: 'v1.4.0', version: '1.4.0' }),
    ).resolves.toMatchObject({ asset: { size: 1_000 }, kind: 'found' });
  });

  // The release builds two files for Windows, and the second one is the one to
  // offer when the installer is not among them.
  it('falls through to the next name the platform would take', async () => {
    const fetchImpl = githubFetch({
      assets: ['CodeBuddy2API-1.4.0-win-x64-portable.exe'],
    });

    await expect(
      findReleaseAsset({
        arch: 'x64',
        fetchImpl,
        platform: 'win32',
        tag: 'v1.4.0',
        version: '1.4.0',
      }),
    ).resolves.toMatchObject({
      asset: { name: 'CodeBuddy2API-1.4.0-win-x64-portable.exe' },
      kind: 'found',
    });
  });

  it('has nothing to offer a machine the release has no file for', async () => {
    await expect(
      findReleaseAsset({
        arch: 'arm64',
        fetchImpl: githubFetch({ assets: [] }),
        platform: 'darwin',
        tag: 'v1.4.0',
        version: '1.4.0',
      }),
    ).resolves.toEqual({ kind: 'no-build' });
  });

  it('has nothing to offer a platform the app is not built for', async () => {
    await expect(
      findReleaseAsset({
        arch: 'ppc64',
        fetchImpl: githubFetch(),
        platform: 'aix',
        tag: 'v1.4.0',
        version: '1.4.0',
      }),
    ).resolves.toEqual({ kind: 'no-build' });
  });

  // A network that dropped every request is not the release answering "no
  // build for this machine": whether there is one is exactly what went
  // unanswered.
  it('does not call a network that answered nothing a release with no file', async () => {
    await expect(
      findReleaseAsset({
        fetchImpl: offlineFetch(),
        tag: 'v1.4.0',
        version: '1.4.0',
      }),
    ).resolves.toEqual({ kind: 'unprobed' });
  });
});

describe('checkForUpdate', () => {
  const newer = () => githubFetch();

  it('offers the build for this machine when a newer release exists', async () => {
    await expect(
      checkForUpdate({
        arch: 'arm64',
        currentVersion: '1.3.15',
        fetchImpl: newer(),
        platform: 'darwin',
      }),
    ).resolves.toEqual({
      asset: expect.objectContaining({
        name: 'CodeBuddy2API-1.4.0-mac-arm64.dmg',
      }),
      kind: 'update',
      version: '1.4.0',
    });
  });

  it('offers no build for a machine the release does not cover', async () => {
    await expect(
      checkForUpdate({
        arch: 'ppc64',
        currentVersion: '1.3.15',
        fetchImpl: newer(),
        platform: 'linux',
      }),
    ).resolves.toEqual({
      asset: null,
      kind: 'update',
      missingAsset: 'no-build',
      version: '1.4.0',
    });
  });

  // Newer, but this machine could not ask about its files: said as that, not
  // as a release that has no build for it.
  it('says the files went unanswered rather than that there are none', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === LATEST_RELEASE_URL
        ? pageResponse(TAG_PAGE)
        : url === LATEST_API_URL
          ? apiResponse({ tag_name: 'v1.4.0' })
          : Promise.reject(new Error('offline')),
    ) as unknown as ReleaseFetch;

    await expect(
      checkForUpdate({
        currentVersion: '1.3.15',
        fetchImpl,
      }),
    ).resolves.toEqual({
      asset: null,
      kind: 'update',
      missingAsset: 'unprobed',
      version: '1.4.0',
    });
  });

  it.each([
    {
      build: () => githubFetch({ tagPage: TAG_PAGE }),
      current: '1.4.0',
      why: 'the version it is already running',
    },
    {
      build: () =>
        githubFetch({
          tagPage:
            'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.3.14',
        }),
      current: '1.3.15',
      why: 'a release older than it',
    },
  ])('is up to date with $why', async ({ build, current }) => {
    await expect(
      checkForUpdate({ currentVersion: current, fetchImpl: build() }),
    ).resolves.toEqual({ kind: 'up-to-date', version: current });
  });

  it('will not call a pre-release an update', async () => {
    const fetchImpl = githubFetch({
      tagPage:
        'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.4.0-beta.1',
    });

    await expect(
      checkForUpdate({ currentVersion: '1.4.0', fetchImpl }),
    ).resolves.toEqual({ kind: 'up-to-date', version: '1.4.0' });
  });

  it('says it could not get an answer when nothing answered', async () => {
    await expect(
      checkForUpdate({ currentVersion: '1.3.15', fetchImpl: offlineFetch() }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'unreachable' });
  });

  it('says the release is not one when its tag is not a version', async () => {
    const fetchImpl = githubFetch({
      tagPage:
        'https://github.com/orangeboyChen/codebuddy2api/releases/tag/nightly',
    });

    await expect(
      checkForUpdate({ currentVersion: '1.3.15', fetchImpl }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no-release' });
  });

  // A build stamped with something that is not a version — a bundler
  // placeholder — cannot be compared, and claiming it is up to date would be a
  // claim nothing checked.
  it('says nothing for a version it cannot read', async () => {
    await expect(
      checkForUpdate({
        currentVersion: '0.0.0 local build',
        fetchImpl: newer(),
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unreadable-version',
    });
  });

  // A development build is behind every release, and it is a version all the
  // same, so it is offered the newest one.
  it('offers the release to a development build', async () => {
    await expect(
      checkForUpdate({ currentVersion: '0.0.0-dev', fetchImpl: newer() }),
    ).resolves.toMatchObject({ kind: 'update', version: '1.4.0' });
  });
});
