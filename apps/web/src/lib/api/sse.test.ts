import { describe, expect, it } from 'vitest';
import { readSse, type SseEvent } from './sse';

const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
const read = async (chunks: string[]) => {
  const out: SseEvent[] = [];
  for await (const ev of readSse(streamOf(chunks))) out.push(ev);
  return out;
};

describe('readSse', () => {
  it('reads named and unnamed events', async () => {
    expect(await read(['event: citations\ndata: {"a":1}\n\ndata: x\n\n'])).toEqual([
      { event: 'citations', data: '{"a":1}' },
      { event: 'message', data: 'x' },
    ]);
  });

  it('handles \\r\\n, and a \\r\\n split across chunks', async () => {
    expect(await read(['data: a\r', '\n\r\ndata: b\r\n\r\n'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('a \\r\\n split between two data lines of one event stays one event', async () => {
    expect(await read(['data: a\r', '\ndata: b\n\n'])).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('joins multi-line data, skips comments, and keeps a colon inside the value', async () => {
    expect(await read([': keep-alive\n', 'data: one\ndata: two: three\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo: three' }]);
  });

  it('delivers a last frame the stream ended without a blank line after', async () => {
    expect(await read(['data: a\n\ndata: b'])).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('drops an event line with no data (nothing to deliver)', async () => {
    expect(await read(['event: ping\n\n'])).toEqual([]);
  });

  it('a multi-byte character split across chunks survives', async () => {
    const bytes = new TextEncoder().encode('data: café\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 10));
        c.enqueue(bytes.slice(10));
        c.close();
      },
    });
    const out: SseEvent[] = [];
    for await (const ev of readSse(body)) out.push(ev);
    expect(out).toEqual([{ event: 'message', data: 'café' }]);
  });
});
