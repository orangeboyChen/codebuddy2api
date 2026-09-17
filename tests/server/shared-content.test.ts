import { describe, expect, it } from 'vitest';

import {
  asRecord,
  readReasoning,
  stringifyContent,
} from '@/lib/server/shared/content';

describe('asRecord', () => {
  it('accepts a plain object', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it('rejects everything that is not a plain object', () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord('text')).toBeNull();
    expect(asRecord(0)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord([{ a: 1 }])).toBeNull();
  });
});

describe('stringifyContent', () => {
  it('passes a string through untouched', () => {
    expect(stringifyContent('hello')).toBe('hello');
    expect(stringifyContent('')).toBe('');
  });

  it('reports nothing for an absent value', () => {
    expect(stringifyContent(undefined)).toBe('');
    expect(stringifyContent(null)).toBe('');
  });

  it('concatenates the text of each part of an array', () => {
    expect(stringifyContent(['a', { text: 'b' }, 'c'])).toBe('abc');
  });

  it('falls back to JSON for a part without text', () => {
    expect(stringifyContent([{ url: 'https://example.com/x.png' }])).toBe(
      '{"url":"https://example.com/x.png"}',
    );
  });

  it('renders an empty text part as nothing', () => {
    expect(stringifyContent([{ text: undefined }])).toBe('');
  });

  it('JSON-encodes a value of any other shape', () => {
    expect(stringifyContent({ a: 1 })).toBe('{"a":1}');
    expect(stringifyContent(42)).toBe('42');
  });
});

describe('readReasoning', () => {
  it('prefers reasoning_content over reasoning', () => {
    expect(readReasoning({ reasoning: 'soon', reasoning_content: 'now' })).toBe(
      'now',
    );
  });

  it('falls back to reasoning', () => {
    expect(readReasoning({ reasoning: 'text' })).toBe('text');
  });

  it('reports nothing when the message carries neither', () => {
    expect(readReasoning({})).toBe('');
    expect(readReasoning(undefined)).toBe('');
  });

  it('ignores reasoning of an unexpected type', () => {
    expect(readReasoning({ reasoning: 42 })).toBe('');
  });
});
