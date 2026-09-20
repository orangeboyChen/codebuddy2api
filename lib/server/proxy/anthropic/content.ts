import { stringifyContent } from '../../shared/content';
import type {
  AnthropicContentBlock,
  AnthropicImageSource,
  ChatContent,
  ChatContentPart,
  ChatImageBlock,
  ChatTextBlock,
  ChatTextContent,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const createAnthropicId = (prefix: string): string => {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
};

export const mapTextPartsToChatContent = (
  parts: Array<string | ChatTextBlock>,
): ChatTextContent => {
  const textParts = parts.filter((part) =>
    typeof part === 'string' ? part.length > 0 : part.text.length > 0,
  );
  const hasStructuredText = textParts.some((part) => typeof part !== 'string');

  if (!hasStructuredText) {
    return textParts.join('\n');
  }

  return textParts.flatMap((part, index) => [
    ...(index > 0 ? [{ type: 'text' as const, text: '\n' }] : []),
    typeof part === 'string' ? { type: 'text' as const, text: part } : part,
  ]);
};

/**
 * Builds the `image_url` value for an Anthropic image block. Base64 sources
 * become a data URI because the upstream Chat/Responses APIs expect a URL;
 * `url` sources pass through untouched. Returns undefined for an unusable
 * source so the caller can fall back to a text placeholder rather than
 * emitting a block the upstream would reject.
 */
export const buildChatImageUrl = (
  source: AnthropicImageSource | undefined,
): string | undefined => {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  if (source.type === 'url' || (!source.data && source.url)) {
    return typeof source.url === 'string' && source.url
      ? source.url
      : undefined;
  }

  if (typeof source.data !== 'string' || !source.data) {
    return undefined;
  }

  const mediaType =
    typeof source.media_type === 'string' && source.media_type
      ? source.media_type
      : 'image/png';

  return `data:${mediaType};base64,${source.data}`;
};

/**
 * Like `mapTextPartsToChatContent`, but keeps image parts as real image
 * blocks instead of collapsing them into text. Falls back to the text-only
 * result when nothing resolved to an image.
 */
export const mapContentPartsToChat = (
  parts: ChatContentPart[],
): ChatContent => {
  const hasImage = parts.some(
    (part) => typeof part === 'object' && part.type === 'image_url',
  );

  if (!hasImage) {
    return mapTextPartsToChatContent(
      parts.filter(
        (part): part is string | ChatTextBlock =>
          typeof part === 'string' || part.type === 'text',
      ),
    );
  }

  const blocks: Array<ChatTextBlock | ChatImageBlock> = [];
  let pendingText: Array<string | ChatTextBlock> = [];

  const flushText = (): void => {
    if (!pendingText.length) {
      return;
    }
    const textContent = mapTextPartsToChatContent(pendingText);
    if (typeof textContent === 'string') {
      blocks.push({ type: 'text', text: textContent });
    } else {
      blocks.push(...textContent);
    }
    pendingText = [];
  };

  for (const part of parts) {
    if (typeof part === 'object' && part.type === 'image_url') {
      flushText();
      blocks.push(part);
      continue;
    }
    pendingText.push(part);
  }

  flushText();

  return blocks;
};

// Claude Code's client-side usage hint, appended to the tail of the
// conversation as a meta message whenever its token-usage attachment is on:
// `<system-reminder>\nToken usage: 190010/180000; -10010 remaining\n
// </system-reminder>`. The wrapped form is matched first so the tags go with
// it; the bare form covers the hint arriving without them. Counts can go
// negative when the client's accounting overruns.
const TOKEN_USAGE_REMINDER_PATTERNS: RegExp[] = [
  /<system-reminder>\s*Token usage:[^<]*<\/system-reminder>/gi,
  /Token usage:\s*-?\d+\s*\/\s*-?\d+\s*;\s*-?\d+\s+remaining/gi,
];

/**
 * Removes Claude Code's usage hint from a text value, leaving whatever it was
 * delivered alongside intact.
 *
 * The hint reports the client's own context accounting to the operator, so it
 * carries nothing the model should act on, and the CodeBuddy upstream rejects a
 * request carrying it.
 */
export const stripTokenUsageReminder = (text: string): string => {
  let stripped = text;

  for (const pattern of TOKEN_USAGE_REMINDER_PATTERNS) {
    stripped = stripped.replace(pattern, '');
  }

  return stripped;
};

export const extractSystemText = (
  system: string | AnthropicContentBlock[] | undefined,
): ChatTextContent => {
  if (!system) {
    return '';
  }

  if (typeof system === 'string') {
    return system;
  }

  return mapTextPartsToChatContent(
    system.map((block) => {
      if (block.type === 'text') {
        const text = block.text ?? '';

        return block.cache_control
          ? { type: 'text', text, cache_control: block.cache_control }
          : text;
      }

      return stringifyContent(block);
    }),
  );
};
