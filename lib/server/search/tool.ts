/**
 * Wire-level constants shared by the Anthropic and Responses proxy paths.
 *
 * Anthropic declares server-side search as a dated tool *type*
 * (`web_search_20260209`, `web_search_20250305`) whose `name` is `web_search`.
 * The OpenAI Responses API used by Codex declares it as the type
 * `web_search_preview`. Both mean "the provider should run a web search", and
 * neither exists upstream, so both are matched here.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** Prefix matching `web_search_20260209`, `web_search_20250305`, and `web_search_preview`. */
export const WEB_SEARCH_TOOL_TYPE_PREFIX = 'web_search';

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
