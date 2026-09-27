import {
  RELEASES_PAGE_URL,
  checkForUpdate,
  compareVersions,
  fetchLatestRelease,
  parseVersion,
  pickAsset,
  releaseFromPayload,
  type ReleaseAsset,
  type ReleaseFetch,
} from '@/lib/server/electron/updates';

const asset = (name: string, url = `https://example.test/${name}`) => ({
  browser_download_url: url,
  name,
  size: 1_000,
});

const release = (
  tag: string,
  assets: Array<ReturnType<typeof asset>> = [
    asset('CodeBuddy2API-1.4.0-mac-arm64.dmg'),
    asset('CodeBuddy2API-1.4.0-mac-x64.dmg'),
    asset('CodeBuddy2API-1.4.0-win-x64-setup.exe'),
    asset('CodeBuddy2API-1.4.0-win-x64-portable.exe'),
    asset('CodeBuddy2API-1.4.0-linux-x64.AppImage'),
    asset('codebuddy2api-1.4.0-linux-x64.deb'),
  ],
): unknown => ({
  assets,
  html_url:
    'https://github.com/orangeboyChen/codebuddy2api/releases/tag/v1.4.0',
  tag_name: tag,
});

const respondWith = (payload: unknown, ok = true): ReleaseFetch =>
  vi.fn(async () => ({
    json: async () => payload,
    ok,
  })) as unknown as ReleaseFetch;

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

describe('pickAsset', () => {
  const assets = releaseFromPayload(release('v1.4.0'))?.assets ?? [];

  it('takes the disk image built for this Mac', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe(
      'CodeBuddy2API-1.4.0-mac-arm64.dmg',
    );
    expect(pickAsset(assets, 'darwin', 'x64')?.name).toBe(
      'CodeBuddy2API-1.4.0-mac-x64.dmg',
    );
  });

  it('takes the installer over the portable build on Windows', () => {
    expect(pickAsset(assets, 'win32', 'x64')?.name).toBe(
      'CodeBuddy2API-1.4.0-win-x64-setup.exe',
    );
  });

  it('takes the AppImage over the package on Linux', () => {
    expect(pickAsset(assets, 'linux', 'x64')?.name).toBe(
      'CodeBuddy2API-1.4.0-linux-x64.AppImage',
    );
  });

  it('has nothing to offer a platform the release does not build for', () => {
    expect(pickAsset(assets, 'darwin', 'ia32')).toBeNull();
    expect(pickAsset(assets, 'aix', 'x64')).toBeNull();
  });

  it('ignores an asset with nowhere to download it from', () => {
    const broken: ReleaseAsset[] = [
      { name: 'CodeBuddy2API-1.4.0-mac-arm64.dmg', size: 0, url: '' },
    ];

    expect(pickAsset(broken, 'darwin', 'arm64')).toBeNull();
  });

  it('recognises a name regardless of how it is capitalised', () => {
    const lowercased: ReleaseAsset[] = [
      {
        name: 'codebuddy2api-1.4.0-linux-arm64.deb',
        size: 0,
        url: 'https://example.test/deb',
      },
    ];

    expect(pickAsset(lowercased, 'linux', 'arm64')?.url).toBe(
      'https://example.test/deb',
    );
  });
});

describe('releaseFromPayload', () => {
  it('reads the version out of the tag', () => {
    expect(releaseFromPayload(release('v1.4.0'))?.version).toBe('1.4.0');
  });

  it('drops the assets it cannot use', () => {
    const parsed = releaseFromPayload({
      assets: [asset('a.dmg'), { name: 'b.dmg' }, null, 'c.dmg'],
      tag_name: 'v1.4.0',
    });

    expect(parsed?.assets).toHaveLength(1);
    expect(parsed?.assets[0].size).toBe(1_000);
  });

  it('falls back to the release page', () => {
    expect(releaseFromPayload({ tag_name: 'v1.4.0' })?.htmlUrl).toBe(
      RELEASES_PAGE_URL,
    );
  });

  it.each([
    { payload: null, why: 'null' },
    { payload: 'release', why: 'a string' },
    { payload: [], why: 'an array' },
  ])('is not a release for $why', ({ payload }) => {
    expect(releaseFromPayload(payload)).toBeNull();
  });

  it('reports no version for a tag that is not one', () => {
    expect(releaseFromPayload({ tag_name: 'nightly' })?.version).toBeNull();
  });
});

describe('fetchLatestRelease', () => {
  it('asks GitHub for the newest release', async () => {
    const fetchImpl = respondWith(release('v1.4.0'));

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toMatchObject({
      version: '1.4.0',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/releases/latest'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'user-agent': expect.any(String) }),
      }),
    );
  });

  it.each([
    { ok: false, why: 'a rate limit' },
    { ok: true, why: 'a payload that is not a release' },
  ])('answers nothing for $why', async ({ ok }) => {
    const fetchImpl = respondWith(ok ? 'nope' : release('v1.4.0'), ok);

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toBeNull();
  });

  it('answers nothing for a network that is not there', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as ReleaseFetch;

    await expect(fetchLatestRelease({ fetchImpl })).resolves.toBeNull();
  });
});

describe('checkForUpdate', () => {
  const newer = respondWith(release('v1.4.0'));

  it('offers the build for this machine when a newer release exists', async () => {
    await expect(
      checkForUpdate({
        arch: 'arm64',
        currentVersion: '1.3.15',
        fetchImpl: newer,
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
        fetchImpl: newer,
        platform: 'linux',
      }),
    ).resolves.toEqual({
      asset: null,
      kind: 'update',
      version: '1.4.0',
    });
  });

  it.each([
    { latest: 'v1.3.15', why: 'the version it is already running' },
    { latest: 'v1.3.14', why: 'a release older than it' },
  ])('is up to date with $why', async ({ latest }) => {
    await expect(
      checkForUpdate({
        currentVersion: '1.3.15',
        fetchImpl: respondWith(release(latest)),
      }),
    ).resolves.toEqual({ kind: 'up-to-date', version: '1.3.15' });
  });

  it('will not call a pre-release an update', async () => {
    await expect(
      checkForUpdate({
        currentVersion: '1.4.0',
        fetchImpl: respondWith(release('v1.4.0-beta.1')),
      }),
    ).resolves.toEqual({ kind: 'up-to-date', version: '1.4.0' });
  });

  it('says nothing when it could not check', async () => {
    await expect(
      checkForUpdate({
        currentVersion: '1.3.15',
        fetchImpl: respondWith(release('v1.4.0'), false),
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  // A build stamped with something that is not a version — a bundler
  // placeholder — cannot be compared, and claiming it is up to date would be a
  // claim nothing checked.
  it('says nothing for a version it cannot read', async () => {
    await expect(
      checkForUpdate({ currentVersion: '0.0.0 local build', fetchImpl: newer }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  // A development build is behind every release, and it is a version all the
  // same, so it is offered the newest one.
  it('offers the release to a development build', async () => {
    await expect(
      checkForUpdate({ currentVersion: '0.0.0-dev', fetchImpl: newer }),
    ).resolves.toMatchObject({ kind: 'update', version: '1.4.0' });
  });
});
