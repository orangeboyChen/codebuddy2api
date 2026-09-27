/**
 * Whether a newer build of the app exists, and which installer this computer
 * wants.
 *
 * The app is published as GitHub release assets — one installer per platform
 * and architecture, named by `electron/electron-builder.yml` — so there is no
 * feed to subscribe to and no update service: the latest release is asked for
 * when the user asks, and the asset for this machine is picked out of it by
 * name.
 */

/** The repository the app is released from. */
export const UPDATE_REPO = 'orangeboyChen/codebuddy2api';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
/** Where to send a machine the release has no build for. */
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases`;
/** GitHub refuses an API request with no `user-agent`, and this is not a browser. */
const USER_AGENT = 'CodeBuddy2API-desktop';
/** Long enough for an installer over a slow line, short enough to give up. */
const RELEASE_TIMEOUT_MS = 30_000;

export interface ReleaseAsset {
  name: string;
  size: number;
  /** The asset itself, not the API entry that describes it. */
  url: string;
}

export interface Release {
  assets: ReleaseAsset[];
  /** The release page, for a release this machine has no build in. */
  htmlUrl: string;
  /** What the tag names, without its leading `v`. Null when the tag is not a version. */
  version: string | null;
}

export type UpdateCheck =
  | {
      kind: 'update';
      /** Null when the release has no build for this platform and architecture. */
      asset: ReleaseAsset | null;
      version: string;
    }
  | { kind: 'unavailable' }
  | { kind: 'up-to-date'; version: string };

export interface ReleaseResponse {
  json: () => Promise<unknown>;
  ok: boolean;
}

export type ReleaseFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
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
 * The installer this machine wants, or null when the release has none for it:
 * a platform the release does not build for, or asset names that moved on.
 *
 * Matched on the ending rather than on the whole name, so a release that
 * changes how it names versions is still recognised, and in the order the
 * platforms prefer — a macOS disk image over nothing, an installer over a
 * portable executable, a self-contained AppImage over a package.
 */
export const pickAsset = (
  assets: ReleaseAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset | null => {
  const suffixes: Partial<Record<NodeJS.Platform, string[]>> = {
    darwin: [`-mac-${arch}.dmg`],
    linux: [`-linux-${arch}.AppImage`, `-linux-${arch}.deb`],
    win32: [`-win-${arch}-setup.exe`, `-win-${arch}-portable.exe`],
  };

  for (const suffix of suffixes[platform] ?? []) {
    const ending = suffix.toLowerCase();
    const found = assets.find(
      (asset) => asset.url && asset.name.toLowerCase().endsWith(ending),
    );

    if (found) {
      return found;
    }
  }

  return null;
};

/** The release as the API describes it, or null when the payload is not one. */
export const releaseFromPayload = (payload: unknown): Release | null => {
  // An array is an object too, and the API answers a list only from an endpoint
  // this does not ask; a list is not one release.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as {
    assets?: unknown;
    html_url?: unknown;
    tag_name?: unknown;
  };
  const tag = typeof record.tag_name === 'string' ? record.tag_name.trim() : '';
  const assets = Array.isArray(record.assets)
    ? record.assets.flatMap((entry): ReleaseAsset[] => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }

        const asset = entry as {
          browser_download_url?: unknown;
          name?: unknown;
          size?: unknown;
        };

        return typeof asset.name === 'string' &&
          typeof asset.browser_download_url === 'string' &&
          asset.name &&
          asset.browser_download_url
          ? [
              {
                name: asset.name,
                size: typeof asset.size === 'number' ? asset.size : 0,
                url: asset.browser_download_url,
              },
            ]
          : [];
      })
    : [];

  return {
    assets,
    htmlUrl:
      typeof record.html_url === 'string' && record.html_url
        ? record.html_url
        : RELEASES_PAGE_URL,
    version: parseVersion(tag) ? tag.replace(/^v/i, '') : null,
  };
};

export interface LatestReleaseOptions {
  fetchImpl?: ReleaseFetch;
  signal?: AbortSignal;
  url?: string;
}

/**
 * The newest release, or null when it cannot be named: no network, no release
 * yet, a rate limit, a payload that changed shape. Nothing here is worth
 * throwing over — the menu bar item can only say it could not check.
 */
export const fetchLatestRelease = async ({
  fetchImpl = fetch as unknown as ReleaseFetch,
  signal = AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  url = LATEST_RELEASE_URL,
}: LatestReleaseOptions = {}): Promise<Release | null> => {
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
      },
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return releaseFromPayload(await response.json());
  } catch {
    return null;
  }
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
    return { kind: 'unavailable' };
  }

  const release = await fetchLatestRelease({ fetchImpl, url });

  if (!release?.version) {
    return { kind: 'unavailable' };
  }

  const difference = compareVersions(release.version, current);

  if (difference === null || difference <= 0) {
    return { kind: 'up-to-date', version: current };
  }

  return {
    asset: pickAsset(release.assets, platform, arch),
    kind: 'update',
    version: release.version,
  };
};
