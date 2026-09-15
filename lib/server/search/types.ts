/**
 * Provider contract for local web search backends.
 *
 * The proxy does not care where results come from — it only needs a query
 * turned into text it can hand back to the model. Anything that can do that
 * (a SearXNG instance, a hosted search API, an internal index) satisfies this
 * interface, so adding a second backend means adding one provider file and one
 * entry in `resolveProvider` rather than touching the proxy loop.
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
