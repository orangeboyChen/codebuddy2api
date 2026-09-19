/**
 * The server-tool backends a deployment can pick, plus the console settings
 * each one needs.
 *
 * Deliberately free of imports so the settings UI — a client component — and
 * the server read the same table. One table then decides which pickers the
 * console offers, which config fields belong to each, and which values the
 * server accepts, so a new backend cannot be selectable in one place and
 * unknown in the other.
 *
 * `passthrough` is gone. A server tool declared by the client is executed here
 * or withdrawn from the request; there is no third option in which the client
 * resolves it, because upstream never offered the tool in the first place.
 */

export type SearchBackend =
  | 'brave'
  | 'bing'
  | 'codebuddy'
  | 'duckduckgo'
  | 'exa'
  | 'searxng'
  | 'serper'
  | 'tavily';

export type FetchBackend =
  'browserable' | 'codebuddy' | 'codebuddy2api' | 'jina';

export const SEARCH_BACKENDS: readonly SearchBackend[] = [
  'codebuddy',
  'searxng',
  'duckduckgo',
  'brave',
  'tavily',
  'serper',
  'bing',
  'exa',
];

export const FETCH_BACKENDS: readonly FetchBackend[] = [
  'codebuddy',
  'codebuddy2api',
  'browserable',
  'jina',
];

/**
 * Defaults for a deployment that has not chosen.
 *
 * Search defaults to SearXNG, which resolves to no provider at all until a URL
 * is configured — the same "not advertised until it can run" behaviour a fresh
 * deployment had before. Fetch defaults to the gateway's own fetcher, which
 * needs no configuration and so is safe to turn on by default.
 */
export const DEFAULT_SEARCH_BACKEND: SearchBackend = 'searxng';
export const DEFAULT_FETCH_BACKENDS: readonly FetchBackend[] = [
  'codebuddy2api',
];

/**
 * Console settings each backend needs before it can run.
 *
 * Empty means the backend works with nothing but what the gateway already has
 * (a saved credential, or no credential at all). The console shows a backend's
 * fields only while that backend is selected; every backend is always offered.
 */
export const SEARCH_BACKEND_CONFIG_KEYS: Record<
  SearchBackend,
  readonly string[]
> = {
  brave: ['CODEBUDDY_BRAVE_API_KEY'],
  bing: ['CODEBUDDY_BING_API_KEY'],
  codebuddy: [],
  duckduckgo: ['CODEBUDDY_DUCKDUCKGO_REGION'],
  exa: ['CODEBUDDY_EXA_API_KEY'],
  searxng: ['CODEBUDDY_SEARXNG_URL', 'CODEBUDDY_SEARXNG_API_KEY'],
  serper: ['CODEBUDDY_SERPER_API_KEY'],
  tavily: ['CODEBUDDY_TAVILY_API_KEY'],
};

export const FETCH_BACKEND_CONFIG_KEYS: Record<
  FetchBackend,
  readonly string[]
> = {
  browserable: ['CODEBUDDY_BROWSERABLE_URL', 'CODEBUDDY_BROWSERABLE_API_KEY'],
  codebuddy: [],
  codebuddy2api: [],
  jina: ['CODEBUDDY_JINA_API_KEY'],
};

/** Every setting key owned by a backend, so the console can hide them from the flat list. */
export const BACKEND_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(SEARCH_BACKEND_CONFIG_KEYS).flat(),
  ...Object.values(FETCH_BACKEND_CONFIG_KEYS).flat(),
]);

/**
 * The value that turns a server tool off.
 *
 * `none` predates this table — it was the old name for "never run this tool" —
 * and it keeps exactly that meaning for both tools, so a deployment that
 * switched a tool off still has it off after upgrading. It is not an engine:
 * the console offers it as an explicit choice for search and as an empty
 * selection for fetch.
 */
export const BACKEND_NONE = 'none';

/**
 * Values accepted from an existing deployment's saved settings.
 *
 * `local` was the previous name for the gateway's own fetcher and is still
 * honoured so an upgrade does not silently change which side executes the tool.
 */
const RENAMED_BACKENDS: Record<string, string> = {
  local: 'codebuddy2api',
};

const normalizeToken = (value: unknown): string => {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();

  return RENAMED_BACKENDS[raw] ?? raw;
};

/** Whether the stored selection is the explicit "off" value. */
export const isBackendDisabled = (value: unknown): boolean =>
  normalizeToken(value) === BACKEND_NONE;

export const normalizeSearchBackend = (value: unknown): SearchBackend => {
  const normalized = normalizeToken(value);

  return (SEARCH_BACKENDS as readonly string[]).includes(normalized)
    ? (normalized as SearchBackend)
    : DEFAULT_SEARCH_BACKEND;
};

/**
 * Normalizes a `web_fetch` backend selection into an ordered list.
 *
 * The console stores the multi-select as one comma-separated string, and older
 * deployments stored a single value, so both are accepted. Order is preserved
 * because the list is tried in order: the first backend that answers wins.
 */
export const normalizeFetchBackends = (value: unknown): FetchBackend[] => {
  const tokens = Array.isArray(value)
    ? value.map((token) => String(token))
    : String(value ?? '').split(/[,;\s]+/);
  const lowercased = tokens
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  // `none` is the off switch, and it is the whole selection that turns the tool
  // off: `jina,none` from a hand-edited config keeps jina, while a value made
  // only of `none` — in any quantity — disables the tool.
  const named = lowercased.filter((token) => token !== BACKEND_NONE);

  if (!named.length && lowercased.length) {
    return [];
  }

  const resolved = named
    .map((token) => RENAMED_BACKENDS[token] ?? token)
    // `passthrough` no longer exists: it meant "the client runs it", and the
    // closest surviving behaviour is the default backend.
    .filter((token) => token !== 'passthrough')
    .filter((token): token is FetchBackend =>
      (FETCH_BACKENDS as readonly string[]).includes(token),
    );

  const unique = [...new Set(resolved)];

  return unique.length ? unique : [...DEFAULT_FETCH_BACKENDS];
};

/**
 * Renders a multi-selection as the one string the console stores.
 *
 * An empty selection is stored as `none` rather than as an empty value, because
 * an empty value is indistinguishable from "never configured" and would be
 * replaced by the default on the way in.
 */
export const serializeFetchBackends = (
  backends: readonly string[] | null | undefined,
): string => (backends?.length ? backends.join(',') : BACKEND_NONE);
