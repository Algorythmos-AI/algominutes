// A recording to a Cloud Storage resumable session while it is still being recorded (RELEASE.md PR 33a
// and 37b, ADR 0002 §2). The session is minted with no length (POST /v1/uploads without totalBytes).
//
// The protocol, as for a file but with the total unknown until the end:
//   - every chunk but the last is a whole number of 256 KiB units, sent as `bytes <a>-<b>/*`;
//   - Cloud Storage answers 308 with `Range: bytes=0-<n>`: what it has kept, which may be less than was sent;
//   - the last one says the total, `bytes <a>-<b>/<total>` (or `bytes */<total>` with nothing left), and is
//     answered 200 or 201.
// After a failure, Cloud Storage is asked what it holds (`bytes */*`, answered with the same 308), and the
// upload goes on from there. Bytes it hasn't acknowledged stay here until it has.

const QUANTUM = 256 * 1024;

export class StreamUploadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StreamUploadError';
  }
}

export interface StreamUploadOptions {
  sessionUri: string;
  fetch: typeof fetch;
  /** The most sent in one PUT (the api's chunkSize); rounded down to whole 256 KiB units. */
  maxChunk?: number;
  /** Failed requests in a row before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Told what Cloud Storage hasn't acknowledged, whenever that changes (37e): where it starts in the recording,
   * and the bytes. The recorder keeps a copy, for recovery if the browser closes.
   */
  onTail?: (tail: { start: number; data: Blob }) => void;
}

/** `Range: bytes=0-N` → N + 1 bytes held; no header means none. */
export function heldBytes(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

export class StreamUpload {
  /** Bytes Cloud Storage has acknowledged: the offset of `pending`'s first byte. */
  private acked = 0;
  private pending: Blob = new Blob([]);
  // Every send chains on the one before, so once one fails, everything after it fails with it, unsent.
  private sending: Promise<void> = Promise.resolve();
  private done = false;
  private readonly maxChunk: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: StreamUploadOptions) {
    this.maxChunk = Math.max(QUANTUM, Math.floor((opts.maxChunk ?? 8 * 1024 * 1024) / QUANTUM) * QUANTUM);
    this.maxRetries = opts.maxRetries ?? 6;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Bytes recorded so far, and bytes Cloud Storage holds. */
  get progress(): { recorded: number; uploaded: number } {
    return { recorded: this.acked + this.pending.size, uploaded: this.acked };
  }

  /** More of the recording. Whole 256 KiB units go out as they fill; the rest waits for the next or for finish(). */
  push(data: Blob): Promise<void> {
    if (this.done) throw new StreamUploadError('The upload has finished');
    this.pending = new Blob([this.pending, data]);
    this.opts.onTail?.({ start: this.acked, data: this.pending });
    this.sending = this.sending.then(() => this.drain(false));
    return this.sending;
  }

  /** The recording has ended: everything left goes, with the total. Resolves once Cloud Storage has the object. */
  finish(): Promise<void> {
    if (this.done) throw new StreamUploadError('The upload has finished');
    this.done = true;
    this.sending = this.sending.then(() => this.drain(true));
    return this.sending;
  }

  private async drain(final: boolean): Promise<void> {
    for (;;) {
      const whole = Math.floor(this.pending.size / QUANTUM) * QUANTUM;
      if (!final && whole === 0) return;
      const size = final ? Math.min(this.pending.size, this.maxChunk) : Math.min(whole, this.maxChunk);
      const last = final && size === this.pending.size;
      const complete = await this.put(size, last);
      if (complete) return;
      if (final && this.pending.size === 0) {
        // Every byte is acknowledged but the object isn't finalised yet: say the total.
        if (await this.put(0, true)) return;
      }
    }
  }

  /** One PUT (retried, resyncing after a failure). True when Cloud Storage says the object is complete. */
  private async put(size: number, last: boolean): Promise<boolean> {
    for (let failures = 0; ; ) {
      const start = this.acked;
      const n = Math.min(size, this.pending.size);
      const total = last ? String(start + this.pending.size) : '*';
      const range = n > 0 ? `bytes ${start}-${start + n - 1}/${total}` : `bytes */${total}`;
      let res: Response | null = null;
      try {
        res = await this.opts.fetch(this.opts.sessionUri, {
          method: 'PUT',
          headers: { 'Content-Range': range },
          body: n > 0 ? this.pending.slice(0, n) : undefined,
        });
      } catch (err) {
        // silent-catch-ok: a dropped connection is retried after a resync, and thrown (as the cause) when the retries run out
        res = null;
        if (++failures > this.maxRetries) throw new StreamUploadError('The upload keeps failing', { cause: err });
      }
      if (res && (res.status === 200 || res.status === 201)) {
        this.ack(start + this.pending.size);
        return true;
      }
      if (res && res.status === 308) {
        const held = heldBytes(res.headers.get('Range'));
        this.ack(held);
        // Progress, or a chunk that isn't the last taken whole: go on. An answer that moves nothing (a last
        // chunk not finalised, or nothing kept) counts as a failure, so a misbehaving session can't loop for ever.
        if (held > start) return false;
        if (++failures > this.maxRetries) throw new StreamUploadError('The upload makes no progress');
        await this.sleep(Math.min(30_000, 500 * 2 ** failures));
        continue;
      }
      if (res && (res.status === 404 || res.status === 410)) {
        throw new StreamUploadError('The upload session has expired');
      }
      if (res && ++failures > this.maxRetries) throw new StreamUploadError(`The upload keeps failing (${res.status})`);
      await this.sleep(Math.min(30_000, 500 * 2 ** failures));
      await this.resync();
    }
  }

  /** Ask Cloud Storage what it holds, after a failure. */
  private async resync(): Promise<void> {
    try {
      const res = await this.opts.fetch(this.opts.sessionUri, { method: 'PUT', headers: { 'Content-Range': 'bytes */*' } });
      if (res.status === 308) this.ack(heldBytes(res.headers.get('Range')));
    } catch (err) {
      // silent-catch-ok: the next PUT is the retry, and its own failure is counted and thrown when they run out
      void err;
    }
  }

  /** Cloud Storage holds `held` bytes: drop them from what's pending. It never holds less than it said before. */
  private ack(held: number): void {
    if (held <= this.acked) return;
    if (held > this.acked + this.pending.size) throw new StreamUploadError('Cloud Storage says it holds bytes never sent');
    this.pending = this.pending.slice(held - this.acked);
    this.acked = held;
    this.opts.onTail?.({ start: this.acked, data: this.pending });
  }
}
