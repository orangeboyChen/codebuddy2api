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
 * Canonical form of a tool name or type, for comparison only.
 *
 * Upstream is not consistent about how it spells these. The wire format is
 * snake_case (`web_fetch`), but a model echoes the call back as `WebFetch` or
 * `Web Fetch` often enough that an exact comparison loses it. Case,
 * underscores, hyphens and spaces carry no meaning in any of the spellings, so
 * they are stripped rather than merely lowercased — `WebFetch` and `web_fetch`
 * have to compare equal, and lowercasing alone cannot make that true.
 */
export const normalizeToolName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[_\-\s]+/g, '');

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
 * Where a server tool runs, and the settings each backend needs.
 *
 * The names say *who* executes the tool, because that is the decision being
 * made — `codebuddy` and `codebuddy2api` are both server-side and differ only
 * in who fetches: CodeBuddy's own agent-tool endpoint versus this machine.
 *
 * The table itself lives in {@link ./backends}: the settings UI is a client
 * component and has to read the same list, so it cannot live in a module that
 * pulls in request plumbing. Re-exported here because the proxy paths already
 * import these names from this module.
 */
export * from './backends';
