/**
 * Whether a newer build of the app exists, and which installer this computer
 * wants.
 *
 * The app is published as GitHub release assets — one installer per platform
 * and architecture, named by `electron/electron-builder.yml` — so there is no
 * feed to subscribe to and no update service: the newest release is asked for
 * when the user asks, and the build for this machine is the one whose own name
 * says it is.
 *
 * Asked of `github.com` rather than of GitHub's API on purpose. The API gives
 * an anonymous caller sixty requests an hour per address, which a shared or
 * corporate one has spent before the day is out — and a check that comes back
 * "no" because it could not be made is worse than no check at all. The release
 * page is where a browser is sent, and the installer is downloaded from the
 * same host, so nothing the app needs sits behind the one door that is limited.
 * The API is still tried when the page cannot say, because it is a different
 * host answering the same question.
 */

/** The repository the app is released from. */
export const UPDATE_REPO = 'orangeboyChen/codebuddy2api';
/** The page that answers which release is the newest, by redirecting to it. */
export const LATEST_RELEASE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
/** The same answer, from the API. Tried when the page cannot give one. */
export const LATEST_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
/** Where to send a machine the release has no build for. */
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases`;
/** The repository itself, which the app's About tab opens. */
export const HOME_PAGE_URL = `https://github.com/${UPDATE_REPO}`;
/** GitHub refuses a request with no `user-agent`, and this is not a browser. */
const USER_AGENT = 'CodeBuddy2API-desktop';
/** Long enough for a slow line to answer, short enough to give up. */
const RELEASE_TIMEOUT_MS = 30_000;
/** Long enough for GitHub to redirect to a file on its own CDN. */
const ASSET_TIMEOUT_MS = 30_000;

export interface ReleaseAsset {
  name: string;
  size: number;
  /** The file itself, not the answer that pointed at it. */
  url: string;
}

export interface Release {
  /** The tag the release was published under: the path its files are under. */
  tag: string;
  /** The release's own page, for a release with no build for this machine. */
  url: string;
  /** What the tag names, without its leading `v`. Null when it is not a version. */
  version: string | null;
}

/** Why the newest release could not be named — what the dialog says. */
export type UpdateUnavailableReason =
  /** Nothing published yet, or a tag that is not a version. */
  | 'no-release'
  /** No answer: no network, or a GitHub that would not say. */
  | 'unreachable'
  /** A build stamped with something that cannot be compared. */
  | 'unreadable-version';

export type UpdateCheck =
  | { asset: ReleaseAsset; kind: 'update'; version: string }
  | {
      asset: null;
      kind: 'update';
      /**
       * Why there is nothing to install: `no-build` when the release has no
       * file for this platform and architecture, `unprobed` when not one of the
       * names could be asked for — which is not the release's answer.
       */
      missingAsset: 'no-build' | 'unprobed';
      version: string;
    }
  | { kind: 'unavailable'; reason: UpdateUnavailableReason }
  | { kind: 'up-to-date'; version: string };

export interface ReleaseResponse {
  headers: { get: (name: string) => string | null };
  json?: () => Promise<unknown>;
  ok: boolean;
  /** Where the request ended up: for the release page, that release's own. */
  url: string;
}

export type ReleaseFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    method?: string;
    redirect?: string;
    signal?: AbortSignal;
  },
) => Promise<ReleaseResponse>;

interface ParsedVersion {
  /** The numeric parts, most significant first. */
  core: number[];
  /** A build marked `-beta.1`, say: older than the same numbers without it. */
  pre: boolean;
}

/**
 * Reads a version out of a tag, a version string, or anything else: null for
 * something that is not one, rather than a guess that would compare as zero.
 */
export const parseVersion = (value: unknown): ParsedVersion | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^v?(\d+(?:\.\d+)*)(?:[-+]([\w.-]+))?$/.exec(value.trim());

  if (!match) {
    return null;
  }

  return {
    core: match[1].split('.').map((part) => Number.parseInt(part, 10)),
    pre: Boolean(match[2]),
  };
};

/**
 * Compares two versions the way releases are ordered: by number, and — for two
 * builds with the same numbers — with the one still marked as a pre-release as
 * the older of the two. Null when either side is not a version, because an
 * answer guessed from an unreadable string is worse than no answer.
 */
export const compareVersions = (left: string, right: string): number | null => {
  const a = parseVersion(left);
  const b = parseVersion(right);

  if (!a || !b) {
    return null;
  }

  const length = Math.max(a.core.length, b.core.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return Number(!a.pre) - Number(!b.pre);
};

/**
 * The tag a release page names: `…/releases/tag/v1.3.15` → `v1.3.15`.
 *
 * Null for anything else, including the page a release is asked *for* — a
 * 404 leaves the request where it started, which is not an answer either.
 */
export const tagFromReleasePage = (value: string): string | null => {
  const match = /\/releases\/tag\/([^/?#]+)/.exec(value ?? '');

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A tag with a stray `%` in it is still the tag that was asked for.
    return match[1];
  }
};

/** The release's own page, which is where a machine with no build is sent. */
export const releasePageUrl = (tag: string): string =>
  `${HOME_PAGE_URL}/releases/tag/${encodeURIComponent(tag)}`;

/** Where GitHub keeps one file of one release. */
export const assetDownloadUrl = (tag: string, name: string): string =>
  `${HOME_PAGE_URL}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

/**
 * The installers this machine wants, named the way
 * `electron/electron-builder.yml` names them, in the order the platform
 * prefers: a macOS disk image; on Windows an installer over a portable
 * executable; on Linux a self-contained AppImage over a package.
 *
 * Empty for a platform the app is not built for.
 */
export const assetNames = (
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] => {
  const names: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: [`CodeBuddy2API-${version}-mac-${arch}.dmg`],
    linux: [
      `CodeBuddy2API-${version}-linux-${arch}.AppImage`,
      `codebuddy2api-${version}-linux-${arch}.deb`,
    ],
    win32: [
      `CodeBuddy2API-${version}-win-${arch}-setup.exe`,
      `CodeBuddy2API-${version}-win-${arch}-portable.exe`,
    ],
  };

  return names[platform] ?? [];
};

export interface LatestReleaseOptions {
  /** Tried when the release page cannot name one. */
  apiUrl?: string;
  fetchImpl?: ReleaseFetch;
  signal?: AbortSignal;
  url?: string;
}

/**
 * The tag of the newest release, read off the page it redirects to.
 *
 * A redirect GitHub did not follow is read out of the header instead, so an
 * answer is not lost to a runtime that hands the 302 back.
 */
const fetchTagFromPage = async (
  fetchImpl: ReleaseFetch,
  url: string,
  signal: AbortSignal,
): Promise<string | null> => {
  let response: ReleaseResponse;

  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal,
    });
  } catch {
    return null;
  }

  return (
    tagFromReleasePage(response.url) ??
    tagFromReleasePage(response.headers.get('location') ?? '')
  );
};

/** The same tag, read out of the API's answer about the newest release. */
const fetchTagFromApi = async (
  fetchImpl: ReleaseFetch,
  url: string,
  signal: AbortSignal,
): Promise<string | null> => {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
      },
      signal,
    });

    if (!response.ok || typeof response.json !== 'function') {
      return null;
    }

    const payload = await response.json();
    const tag =
      payload && typeof payload === 'object'
        ? (payload as { tag_name?: unknown }).tag_name
        : undefined;

    return typeof tag === 'string' && tag.trim() ? tag.trim() : null;
  } catch {
    return null;
  }
};

/**
 * A wait the fallback can still use.
 *
 * The page and the API share one timeout, which is what makes the wait bounded
 * at all — but the shared signal has already run out when the page was the
 * thing that hung, and an aborted signal would fail the API's request before it
 * was ever made. Which is the one case the fallback exists for.
 */
const fallbackSignal = (signal: AbortSignal): AbortSignal =>
  signal.aborted ? AbortSignal.timeout(RELEASE_TIMEOUT_MS) : signal;

/**
 * The newest release, or null when it cannot be named: no network, no release
 * yet, a payload that changed shape. Nothing here is worth throwing over — the
 * menu bar item can only say that it could not check.
 */
export const fetchLatestRelease = async ({
  apiUrl = LATEST_API_URL,
  fetchImpl = fetch as unknown as ReleaseFetch,
  signal = AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  url = LATEST_RELEASE_URL,
}: LatestReleaseOptions = {}): Promise<Release | null> => {
  const tag =
    (await fetchTagFromPage(fetchImpl, url, signal)) ??
    (await fetchTagFromApi(fetchImpl, apiUrl, fallbackSignal(signal)));

  if (!tag) {
    return null;
  }

  return {
    tag,
    url: releasePageUrl(tag),
    version: parseVersion(tag) ? tag.replace(/^v/i, '') : null,
  };
};

export interface FindAssetOptions {
  arch?: string;
  fetchImpl?: ReleaseFetch;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** The tag the release was published under: the path its files are under. */
  tag: string;
  /** The version the file was named with: the tag without its leading `v`. */
  version: string;
}

/**
 * What asking a release for this machine's installer came back with.
 *
 * "No file for this computer" and "no request got through" are different
 * answers, and only the first one is the release's: the second says nothing
 * about whether a build exists, so it must not be shown as though it did.
 */
export type AssetProbe =
  /** The file this machine wants, in the release that is out. */
  | { asset: ReleaseAsset; kind: 'found' }
  /** Asked, and the release has no file for this platform and architecture. */
  | { kind: 'no-build' }
  /** Not one of the names could be asked for: no answer either way. */
  | { kind: 'unprobed' };

/**
 * The installer this machine wants inside a release, found by asking GitHub
 * for the file: answered with a redirect to it when it is there, and with a
 * 404 when the release has none under that name.
 *
 * Only the head is asked for, so a hundred megabytes are never downloaded to
 * find out whether they exist.
 */
export const findReleaseAsset = async ({
  arch,
  fetchImpl = fetch as unknown as ReleaseFetch,
  platform,
  signal = AbortSignal.timeout(ASSET_TIMEOUT_MS),
  tag,
  version,
}: FindAssetOptions): Promise<AssetProbe> => {
  const names = assetNames(version, platform, arch);

  // A platform the app is not built for: nothing to ask about, and the release
  // cannot have answered for it.
  if (!names.length) {
    return { kind: 'no-build' };
  }

  let asked = 0;

  for (const name of names) {
    const url = assetDownloadUrl(tag, name);

    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT },
        method: 'HEAD',
        redirect: 'follow',
        signal,
      });

      // An answer, whether it is the file or the 404 that says there is none.
      asked += 1;

      if (!response.ok) {
        continue;
      }

      const length = Number.parseInt(
        response.headers.get('content-length') ?? '',
        10,
      );

      return {
        asset: { name, size: Number.isFinite(length) ? length : 0, url },
        kind: 'found',
      };
    } catch {
      // A network that will not make the request, or one that dropped it: the
      // next name is the next thing to try.
    }
  }

  return { kind: asked ? 'no-build' : 'unprobed' };
};

export interface CheckForUpdateOptions {
  arch?: string;
  currentVersion: string;
  fetchImpl?: ReleaseFetch;
  platform?: NodeJS.Platform;
  url?: string;
}

/**
 * Whether the app the user is running is the newest one there is.
 *
 * A version that cannot be compared — a build stamped with something that is
 * not a version — answers `unavailable` rather than `up-to-date`: saying there
 * is nothing new is only honest when it was actually checked.
 */
export const checkForUpdate = async ({
  arch,
  currentVersion,
  fetchImpl,
  platform,
  url,
}: CheckForUpdateOptions): Promise<UpdateCheck> => {
  const current = currentVersion.trim();

  if (!parseVersion(current)) {
    return { kind: 'unavailable', reason: 'unreadable-version' };
  }

  const release = await fetchLatestRelease({ fetchImpl, url });

  if (!release) {
    return { kind: 'unavailable', reason: 'unreachable' };
  }

  // Published, but under a tag that is not a version: there is nothing to
  // compare this build against, and nothing to offer either.
  if (!release.version) {
    return { kind: 'unavailable', reason: 'no-release' };
  }

  const difference = compareVersions(release.version, current);

  if (difference === null || difference <= 0) {
    return { kind: 'up-to-date', version: current };
  }

  const probe = await findReleaseAsset({
    arch,
    fetchImpl,
    platform,
    tag: release.tag,
    version: release.version,
  });

  if (probe.kind === 'found') {
    return { asset: probe.asset, kind: 'update', version: release.version };
  }

  return {
    asset: null,
    kind: 'update',
    missingAsset: probe.kind,
    version: release.version,
  };
};
