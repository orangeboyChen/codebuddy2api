/**
 * Wire-level constants shared by the Anthropic and Responses proxy paths.
 *
 * Anthropic declares server-side search as a dated tool *type*
 * (`web_search_20260209`, `web_search_20250305`) whose `name` is `web_search`.
 * The OpenAI Responses API used by Codex declares it as the type
 * `web_search_preview`. Both mean "the provider should run a web search", and
 * neither exists upstream, so both are matched here.
 *
 * `web_fetch` follows the same pattern: Anthropic ships it as
 * `web_fetch_20250910` and Responses clients send a plain function tool named
 * `web_fetch`. Upstream has no such server tool, so the proxy executes it
 * locally exactly as it does search.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** Prefix matching `web_search_20260209`, `web_search_20250305`, and `web_search_preview`. */
export const WEB_SEARCH_TOOL_TYPE_PREFIX = 'web_search';

export const WEB_FETCH_TOOL_NAME = 'web_fetch';

/** Prefix matching Anthropic's dated `web_fetch_20250910` and `web_fetch_preview`. */
export const WEB_FETCH_TOOL_TYPE_PREFIX = 'web_fetch';

/**
 * The function tool handed to upstream. The description states *when* to call
 * it as well as what it does — models that reach for tools conservatively need
 * the trigger condition spelled out.
 */
export const buildWebSearchToolDefinition = (): {
  description: string;
  name: string;
  parameters: Record<string, unknown>;
} => {
  return {
    description:
      'Search the web for current information. Use this whenever the answer depends on recent events, live data, or facts you cannot verify from the conversation alone — do not answer those from memory. Returns the top results with their titles, URLs, and text snippets.',
    name: WEB_SEARCH_TOOL_NAME,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The search query, phrased as you would type it into a search engine.',
        },
      },
      required: ['query'],
    },
  };
};

/**
 * The `web_fetch` function tool handed to upstream.
 *
 * `prompt` is optional even though every client that ships this tool treats it
 * as required: a model that omits it still has a usable URL, and rejecting the
 * call would waste a turn on a technicality. The local backend ignores it; the
 * CodeBuddy backend uses it as an extraction hint.
 */
export const buildWebFetchToolDefinition = (): {
  description: string;
  name: string;
  parameters: Record<string, unknown>;
} => {
  return {
    description:
      'Fetch a specific web page and read its content. Use this when you already have a URL — from a previous search result, from the user, or from a citation — and need what the page actually says. Do not use it to look something up; search for that instead.',
    name: WEB_FETCH_TOOL_NAME,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The absolute URL of the page to fetch, including https://.',
        },
        prompt: {
          type: 'string',
          description:
            'What to extract from the page, e.g. "the pricing tiers" or "the release date".',
        },
      },
      required: ['url'],
    },
  };
};

/**
 * Marks a translated tool as having been declared by the client as a
 * provider-executed server tool.
 *
 * The Responses path necessarily flattens `web_fetch_20250910` into a plain
 * function for upstream, which loses the information that the client asked for a
 * server tool rather than declaring its own. The proxy loop later needs that
 * distinction: an unexecutable server-tool declaration is dropped, while a
 * client-owned function is forwarded untouched.
 *
 * This is a private, non-standard field that travels only between the Responses
 * translator and the proxy loop; the loop strips it before anything is sent
 * upstream.
 */
const SERVER_TOOL_MARKER = 'x-codebuddy2api-server-tool';

export const markServerTool = <T>(tool: T): T & Record<string, unknown> => {
  if (!tool || typeof tool !== 'object') {
    return tool as T & Record<string, unknown>;
  }

  return { ...tool, [SERVER_TOOL_MARKER]: true };
};

export const isMarkedServerTool = (tool: unknown): boolean => {
  if (!tool || typeof tool !== 'object') {
    return false;
  }

  return (tool as Record<string, unknown>)[SERVER_TOOL_MARKER] === true;
};

/** Removes the private marker so nothing non-standard reaches upstream. */
export const stripServerToolMarker = <T>(tool: T): T => {
  if (!tool || typeof tool !== 'object') {
    return tool;
  }

  const { [SERVER_TOOL_MARKER]: _marker, ...rest } = tool as Record<
    string,
    unknown
  >;

  return rest as T;
};

/**
 * Where a server tool runs.
 *
 * The names say *who* executes the tool, because that is the decision being
 * made. `codebuddy` and `codebuddy2api` are both server-side and differ only in
 * who fetches: CodeBuddy's own agent-tool endpoint versus this machine.
 * `passthrough` leaves the tool in the request, so the client (Claude Code,
 * Codex) runs it itself.
 */
export type SearchBackend = 'codebuddy' | 'searxng' | 'passthrough';
export type FetchBackend = 'codebuddy' | 'codebuddy2api' | 'passthrough';

export const SEARCH_BACKENDS: readonly SearchBackend[] = [
  'codebuddy',
  'searxng',
  'passthrough',
];
export const FETCH_BACKENDS: readonly FetchBackend[] = [
  'codebuddy',
  'codebuddy2api',
  'passthrough',
];

export const DEFAULT_SEARCH_BACKEND: SearchBackend = 'searxng';
export const DEFAULT_FETCH_BACKEND: FetchBackend = 'passthrough';

/**
 * Values accepted from an existing deployment's saved settings.
 *
 * `local` and `none` were the previous names and are still honoured so an
 * upgrade does not silently change which side executes the tool — `none` in
 * particular meant "client runs it", which is easy to mistake for "off".
 */
const RENAMED_BACKENDS: Record<string, string> = {
  local: 'codebuddy2api',
  none: 'passthrough',
};

const normalizeBackend = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  const current = RENAMED_BACKENDS[normalized] ?? normalized;

  return (allowed as readonly string[]).includes(current)
    ? (current as T)
    : fallback;
};

export const normalizeSearchBackend = (value: unknown): SearchBackend =>
  normalizeBackend(value, SEARCH_BACKENDS, DEFAULT_SEARCH_BACKEND);

export const normalizeFetchBackend = (value: unknown): FetchBackend =>
  normalizeBackend(value, FETCH_BACKENDS, DEFAULT_FETCH_BACKEND);
