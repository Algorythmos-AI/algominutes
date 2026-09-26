// A Server-Sent Events reader for fetch bodies (the /v1/chat stream). The
// browser's EventSource can't send a POST body or an Authorization header,
// so the stream is read from the response instead.

export interface SseEvent {
  /** The `event:` field; "message" when the frame had none. */
  event: string;
  data: string;
}

/** Yields each event in `body` as its frame completes. Handles \n, \r\n and \r line ends, split chunks and multi-line data. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const dispatch = (): SseEvent | null => {
    const out = data.length ? { event: event || 'message', data: data.join('\n') } : null;
    event = '';
    data = [];
    return out;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // A trailing lone \r may be half of a \r\n split across chunks: keep it until the next chunk.
      const lines = buffer.split(/\r\n|\n|\r(?!$)/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          const ev = dispatch();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value_ = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value_;
        else if (field === 'data') data.push(value_);
      }
    }
    // A stream that ends without a blank line still delivers its last frame.
    if (buffer) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
      else if (buffer.startsWith('event:')) event = buffer.slice(6).replace(/^ /, '');
    }
    const last = dispatch();
    if (last) yield last;
  } finally {
    // An early exit (the consumer stopped reading, or unmounted) closes the connection, not just the lock.
    try {
      await reader.cancel();
    } catch {
      // silent-catch-ok: cancelling a stream that already ended or errored has nothing to report
    }
    reader.releaseLock();
  }
}
