/**
 * Chat completions are called from browser-side clients as well as servers, so
 * this route's streams carry the CORS header the other protocols do not need.
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
};

export interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /**
   * Prior-turn reasoning for an assistant message.
   *
   * Not an OpenAI field. The CodeBuddy chat upstream accepts it on assistant
   * messages and uses it to carry reasoning across turns — the same slot
   * CodeBuddy's own client populates when it replays a response. It is named
   * `reasoning` rather than `reasoning_content` because that one is the
   * upstream's *response* field; this is the request-side counterpart.
   */
  reasoning?: string;
  /**
   * The same reasoning in the spelling an OpenAI-compatible client sends.
   *
   * Not what the chat upstream reads on the way in — that is `reasoning`
   * above — but clients replaying a response we handed them echo back exactly
   * what they received, and the reasoning we emit is `reasoning_content`. It
   * is recognised on input so the replay can be forwarded, never required.
   */
  reasoning_content?: string;
}

export interface CacheableTextBlock {
  cache_control?: { type: 'ephemeral' };
  text: string;
  type: 'text';
}

export const MIN_AUTO_CACHE_TEXT_LENGTH = 1024;
export const MAX_STREAM_FRAME_LENGTH = 1_000_000;
export const CODEBUDDY_CLI_VERSION = '2.137.1';
export const CODEBUDDY_USER_AGENT = `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`;

export interface ChatRequestBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: unknown;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  thinking?: Record<string, unknown>;
  reasoning_effort?: string;
}

export interface ChatStreamDelta {
  content?: string;
  role?: string;
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      arguments?: string;
      name?: string;
    };
  }>;
}

export interface ChatStreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  usage?: unknown;
  choices?: Array<{
    delta?: ChatStreamDelta;
    finish_reason?: string | null;
    index?: number;
  }>;
}

export type ToolCallChunk = NonNullable<ChatStreamDelta['tool_calls']>[number];

export interface ToolCallMapping {
  id: string;
  index: number;
}

export interface ToolCallNormalizationState {
  mappings: Map<string, ToolCallMapping>;
  nextIndex: number;
}

export interface ResolvedAuth {
  type: 'bearer';
  bearerToken: string;
  userId: string;
  credentialData: Record<string, unknown>;
}

export interface ProxyContext {
  accessKeyId: string | null;
  accessKeyName: string | null;
  auth: ResolvedAuth;
  credentialFilename: string | null;
  preferences: {
    firstMessageRoleToSystem: boolean;
    firstSystemMessageRoleToUser: boolean;
    upstreamProtocol: 'chat' | 'responses';
  };
}

export interface DiscoveredModel {
  displayName: string;
  id: string;
}
