// ---------------------------------------------------------------------------
// Anthropic Messages API types
// ---------------------------------------------------------------------------

export const MAX_STREAM_FRAME_LENGTH = 1_000_000;

export interface AnthropicImageSource {
  type?: string;
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: { type?: string };
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  /**
   * Accepted on inbound blocks but never sent by us — see
   * `buildThinkingBlock`. Anthropic's signatures hold an encrypted copy of the
   * reasoning; a client may replay one from a session it started elsewhere, and
   * we skip those rather than forward ciphertext as if it were text.
   */
  signature?: string;
  /** Present on `redacted_thinking` blocks, which carry no readable text. */
  data?: string;
  tool_use_id?: string;
  content?: unknown;
  source?: AnthropicImageSource;
}

export interface AnthropicMessage {
  /**
   * `system` is not part of the documented Messages schema, but clients send it
   * inside `messages` anyway, so it is modelled here — see the role handling in
   * `mapAnthropicContentToChat`.
   */
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  type?: string;
  // Server-declared tools (web_search / web_fetch) carry extra configuration
  // that `mapAnthropicToolsToChat` forwards verbatim to the upstream.
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_uses?: number;
  user_location?: Record<string, unknown>;
}

export interface AnthropicThinkingConfig {
  type?: string;
  budget_tokens?: number;
}

export interface AnthropicMessagesRequestBody {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  thinking?: AnthropicThinkingConfig;
  /**
   * Not an Anthropic field. Clients that speak the OpenAI vocabulary send their
   * thinking depth here instead of as a `thinking` block, and dropping it would
   * leave the request with no thinking depth at all.
   */
  reasoning_effort?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI response types (mirrors of codebuddy.ts internals)
// ---------------------------------------------------------------------------

export interface OpenAIToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

export interface OpenAIChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  reasoning?: string;
}

export interface OpenAIChatChoice {
  index?: number;
  message?: OpenAIChatMessage;
  delta?: OpenAIChatMessage;
  finish_reason?: string | null;
}

export interface OpenAIStreamError {
  error?: { message?: string; status?: number };
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: OpenAIUsage;
}

export interface ChatTextBlock {
  cache_control?: { type?: string };
  text: string;
  type: 'text';
}

/**
 * An image part in the OpenAI Chat shape. Emitted in this shape rather than a
 * native Anthropic one because the request is translated to Chat before it
 * reaches CodeBuddy: the `chat` upstream forwards it verbatim and the
 * `responses` upstream converts it to `input_image`.
 */
export interface ChatImageBlock {
  cache_control?: { type?: string };
  image_url: { url: string };
  type: 'image_url';
}

export type ChatContentPart = string | ChatTextBlock | ChatImageBlock;

export type ChatContent = string | Array<ChatTextBlock | ChatImageBlock>;

/**
 * Text-only content, used where images are not representable — the system
 * prompt and the intermediate text-part buffer.
 */
export type ChatTextContent = string | ChatTextBlock[];

export interface ChatMessage {
  role: string;
  content: ChatContent | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  /**
   * Prior-turn reasoning for this assistant message. Not part of the OpenAI
   * schema; the CodeBuddy chat upstream round-trips it, and a provider that
   * does not know the field ignores it.
   */
  reasoning?: string;
}

export interface StreamingToolUseState {
  id: string;
  name: string;
  input: string;
  index: number;
  started: boolean;
  blockEmitted: boolean;
}
