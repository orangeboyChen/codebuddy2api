import { describe, expect, it } from 'vitest';

import {
  createSseHeaders,
  createSseResponse,
  DONE_FRAME_TEXT,
  encodeDoneFrame,
  encodeEventFrame,
  eventFrameText,
} from '@/lib/server/shared/sse';

const decoder = new TextDecoder();

const decode = (chunk: Uint8Array): string => decoder.decode(chunk);

describe('createSseHeaders', () => {
  it('carries the three headers every stream needs', () => {
    expect(createSseHeaders()).toEqual({
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    });
  });

  it('lets a caller add to the set without losing the rest', () => {
    const headers = createSseHeaders({ 'Access-Control-Allow-Origin': '*' });

    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Cache-Control']).toBe('no-cache');
  });
});

describe('createSseResponse', () => {
  it('defaults to 200', async () => {
    const response = createSseResponse('data: x\n\n');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: x\n\n');
  });

  it('passes an explicit status through, including a null-body one', () => {
    const response = createSseResponse(null, { status: 204 });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe('frame serialisation', () => {
  it('writes a named event with its type line', () => {
    const frame = decode(encodeEventFrame('response.created', { id: 'r1' }));

    expect(frame).toBe('event: response.created\ndata: {"id":"r1"}\n\n');
  });

  it('writes the terminating frame', () => {
    expect(decode(encodeDoneFrame())).toBe('data: [DONE]\n\n');
  });

  it('omits the terminator from the text forms, which are joined with it', () => {
    expect(eventFrameText('response.created', { id: 'r1' })).toBe(
      'event: response.created\ndata: {"id":"r1"}',
    );
    expect(DONE_FRAME_TEXT).toBe('data: [DONE]');
    expect([eventFrameText('a', {}), DONE_FRAME_TEXT, ''].join('\n\n')).toBe(
      'event: a\ndata: {}\n\ndata: [DONE]\n\n',
    );
  });
});
