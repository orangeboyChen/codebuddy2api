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

/**
 * A promotion upstream attaches to a model — a discount window, a badge such
 * as `限时免费`, or both.
 *
 * Upstream ships these server-side and only alongside the catalogs that carry
 * them, so every field is optional and an account without a running promotion
 * simply has none. Billing stays with upstream: the console reports what it
 * was told, and never recomputes a price.
 */
export interface DiscoveredModelPromotion {
  /** The multiplier charged while the promotion runs, for example `"x0.00"`. */
  discountedCredits?: string;
  /** ISO timestamp after which upstream stops applying the promotion. */
  endsAt?: string;
  /** The badge label upstream shows next to the model, localised by upstream. */
  label?: string;
  /** ISO timestamp the promotion starts applying. */
  startsAt?: string;
  /** Operator copy upstream shows with the badge, in Chinese and English. */
  textEn?: string;
  textZh?: string;
}

/**
 * The account tier upstream requires before it serves a model, for example
 * `advanced`. Models below the account's tier are quoted with an upgrade hint.
 */
export interface DiscoveredModelTier {
  /** The badge label upstream shows, for example `高级版`. */
  label?: string;
  /** The tier level: `trial`, `standard`, `advanced` or `flagship`. */
  level?: string;
}

/**
 * A model the upstream config offers to a credential.
 *
 * Only `id` and `displayName` are guaranteed. The remaining fields come from
 * the `/v3/config` model catalog and are absent whenever upstream describes a
 * model sparsely, so consumers must treat them as optional.
 */
export interface DiscoveredModel {
  /**
   * Capability tags upstream declares on the model — `craft`, `text-to-image`
   * and friends — with the `badge:` tags read as badges stripped out.
   */
  capabilityTags?: string[];
  /**
   * Credit multiplier upstream bills for this model, for example `"x3.33"`.
   * Absent for models whose cost upstream does not advertise.
   */
  credits?: string;
  contextWindow?: number;
  /**
   * The context lengths upstream lets a caller choose between, for example
   * `[200000, 1000000]`. Empty when only the default window is offered.
   */
  contextLengths?: number[];
  /**
   * The thinking effort upstream applies when a caller names none, for example
   * `high`.
   */
  defaultEffort?: string;
  descriptionEn?: string;
  descriptionZh?: string;
  displayName: string;
  id: string;
  /**
   * Whether upstream marks the model as the account's default, which is the
   * model a request gets when the caller names none.
   */
  isDefault?: boolean;
  /**
   * Whether upstream tags the model with the enterprise badge; such models are
   * only served to accounts that belong to an enterprise.
   */
  isEnterprise?: boolean;
  isFree?: boolean;
  isInternal?: boolean;
  /**
   * The largest request upstream accepts, which can sit below the context
   * window: the window is what the model understands, this is what one call
   * may carry.
   */
  maxAllowedSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /**
   * Whether upstream serves the model in thinking mode only — a caller cannot
   * turn thinking off, so a client that tries gets an error back.
   */
  onlyReasoning?: boolean;
  promotion?: DiscoveredModelPromotion;
  /**
   * The ids behind this model's variants, keyed by variant — `lite`,
   * `reasoning`, `vision`, `longContext`, `subagent` — as upstream declares
   * them.
   */
  relatedModels?: Record<string, string>;
  /** The thinking efforts upstream lets a caller pick from. */
  supportedEfforts?: string[];
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  tier?: DiscoveredModelTier;
  vendor?: string;
}
