/**
 * Provider contract for server-side tool backends.
 *
 * The proxy does not care where a result comes from — it only needs an
 * invocation turned into text it can hand back to the model. Anything that can
 * do that (a SearXNG instance, CodeBuddy's own agent-tool endpoints, a local
 * fetch) satisfies this interface, so adding a backend means adding one
 * provider file and one registry entry rather than touching the proxy loop.
 */
export interface WebSearchResult {
  content?: string;
  title?: string;
  url?: string;
}

export interface WebSearchResponse {
  /** Text handed back to the model; also used directly as the tool result. */
  content: string;
  results: WebSearchResult[];
}

export interface WebSearchProvider {
  /** Stable identifier, used for logging and for the console's capability signal. */
  readonly id: string;
  search: (query: string) => Promise<WebSearchResponse>;
}

/**
 * Result of one `web_fetch` invocation.
 *
 * A fetch returns page text rather than a list of hits, so the two tools share
 * only the text that reaches the model. Keeping the shapes separate avoids
 * forcing a fetch to fabricate a `results` array it has no use for.
 */
export interface WebFetchResponse {
  /** Text handed back to the model; also used directly as the tool result. */
  content: string;
  /** Final URL after redirects, when the backend reports one. */
  url?: string;
}

/** Arguments a model may send to `web_fetch`. */
export interface WebFetchQuery {
  /** What to extract from the page; optional for backends that ignore it. */
  prompt?: string;
  url: string;
}

export interface WebFetchProvider {
  /** Stable identifier, used for logging and for the console's capability signal. */
  readonly id: string;
  fetch: (query: WebFetchQuery) => Promise<WebFetchResponse>;
}
