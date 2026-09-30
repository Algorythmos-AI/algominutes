import { describe, it, expect } from 'vitest';
import { StreamUpload, StreamUploadError, heldBytes } from './stream-upload';

const KiB = 1024;
const Q = 256 * KiB;

/** Bytes 0..n-1 of a recognisable sequence, from `from`. */
const bytes = (n: number, from = 0) => new Blob([Uint8Array.from({ length: n }, (_, i) => (from + i) % 251)]);

/**
 * Cloud Storage's resumable session, strictly: every chunk but the last a whole number of 256 KiB units,
 * starting exactly where it left off; `keep` can make it hold fewer bytes than it was sent.
 */
function fakeGcs(opts: { keep?: (sent: number) => number; fail?: (n: number, range: string) => 'net' | number | null; slowFinalise?: boolean } = {}) {
  let held = new Uint8Array(0);
  let complete = false;
  const ranges: string[] = [];
  let n = 0;
  const f = (async (_url: string, init: RequestInit) => {
    const range = (init.headers as Record<string, string>)['Content-Range']!;
    ranges.push(range);
    const failure = opts.fail?.(++n, range);
    if (failure === 'net') throw new TypeError('Failed to fetch');
    if (typeof failure === 'number') return new Response('', { status: failure });
    const done = () => new Response('{}', { status: 200 });
    const more = () => new Response('', { status: 308, headers: held.length ? { Range: `bytes=0-${held.length - 1}` } : {} });
    if (complete) return done();
    const status = /^bytes \*\/(\*|\d+)$/.exec(range);
    if (status) {
      if (status[1] !== '*' && Number(status[1]) === held.length) { complete = true; return done(); }
      return more();
    }
    const m = /^bytes (\d+)-(\d+)\/(\*|\d+)$/.exec(range)!;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a !== held.length) return new Response('', { status: 503 });
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    expect(body.length).toBe(b - a + 1);
    const last = m[3] !== '*' && b + 1 === Number(m[3]);
    if (!last) expect(body.length % Q).toBe(0);
    const kept = last ? body.length : Math.min(body.length, opts.keep ? opts.keep(body.length) : body.length);
    const next = new Uint8Array(held.length + kept);
    next.set(held);
    next.set(body.subarray(0, kept), held.length);
    held = next;
    // A session may keep the last chunk before it finalises: then only saying the total finishes it.
    if (last && opts.slowFinalise) return more();
    if (last) { complete = true; return done(); }
    return more();
  }) as unknown as typeof fetch;
  return { fetch: f, ranges, object: () => held, complete: () => complete };
}

const noSleep = async () => {};
const expectSame = async (got: Uint8Array, want: Blob) => expect(Buffer.from(got).equals(Buffer.from(await want.arrayBuffer()))).toBe(true);

describe('heldBytes', () => {
  it('reads Cloud Storage\'s Range', () => {
    expect(heldBytes('bytes=0-262143')).toBe(Q);
    expect(heldBytes(null)).toBe(0);
  });
});

describe('uploading while recording', () => {
  it('sends each whole 256 KiB as it fills, and the rest with the total at the end', async () => {
    const gcs = fakeGcs();
    const up = new StreamUpload({ sessionUri: 'https://storage.googleapis.com/upload/x', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(100 * KiB));
    expect(gcs.ranges).toEqual([]); // less than a unit: nothing yet
    await up.push(bytes(200 * KiB, 100 * KiB));
    expect(gcs.ranges).toEqual([`bytes 0-${Q - 1}/*`]);
    expect(up.progress).toEqual({ recorded: 300 * KiB, uploaded: Q });
    await up.push(bytes(300 * KiB, 300 * KiB));
    await up.finish();
    expect(gcs.ranges).toEqual([`bytes 0-${Q - 1}/*`, `bytes ${Q}-${2 * Q - 1}/*`, `bytes ${2 * Q}-${600 * KiB - 1}/${600 * KiB}`]);
    expect(gcs.complete()).toBe(true);
    await expectSame(gcs.object(), bytes(600 * KiB));
  });

  it('a big backlog goes in pieces no larger than the api\'s chunk size', async () => {
    const gcs = fakeGcs();
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, maxChunk: 2 * Q + 1000, sleep: noSleep });
    await up.push(bytes(5 * Q + 10));
    await up.finish();
    expect(gcs.ranges.slice(0, 2)).toEqual([`bytes 0-${2 * Q - 1}/*`, `bytes ${2 * Q}-${4 * Q - 1}/*`]);
    await expectSame(gcs.object(), bytes(5 * Q + 10));
  });

  it('when Cloud Storage keeps less than it was sent, the rest is sent again', async () => {
    const gcs = fakeGcs({ keep: (sent) => (sent > Q ? Q : sent) });
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(3 * Q));
    await up.finish();
    await expectSame(gcs.object(), bytes(3 * Q));
  });

  it('after a failure or a dropped connection, it asks what Cloud Storage holds and goes on from there', async () => {
    const gcs = fakeGcs({ fail: (n) => (n === 2 ? 503 : n === 4 ? 'net' : null) });
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(2 * Q));
    await up.push(bytes(Q, 2 * Q));
    await up.finish();
    expect(gcs.ranges).toContain('bytes */*');
    await expectSame(gcs.object(), bytes(3 * Q));
  });

  it('every byte acknowledged before the end: the end only says the total', async () => {
    const gcs = fakeGcs();
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(Q));
    await up.finish();
    expect(gcs.ranges).toEqual([`bytes 0-${Q - 1}/*`, `bytes */${Q}`]);
    expect(gcs.complete()).toBe(true);
  });

  it('an expired session fails at once, and nothing more is sent after it', async () => {
    const gcs = fakeGcs({ fail: (n) => (n === 1 ? 410 : null) });
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await expect(up.push(bytes(Q))).rejects.toThrow(StreamUploadError);
    await expect(up.finish()).rejects.toThrow('expired');
    expect(gcs.ranges).toHaveLength(1);
  });

  it('a last chunk kept but not finalised: saying the total finishes it', async () => {
    const gcs = fakeGcs({ slowFinalise: true });
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(Q + 100));
    await up.finish();
    expect(gcs.ranges.slice(-2)).toEqual([`bytes ${Q}-${Q + 99}/${Q + 100}`, `bytes */${Q + 100}`]);
    expect(gcs.complete()).toBe(true);
    await expectSame(gcs.object(), bytes(Q + 100));
  });

  it('gives up after too many failures in a row', async () => {
    const gcs = fakeGcs({ fail: (_n, range) => (range === 'bytes */*' ? null : 503) });
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, maxRetries: 2, sleep: noSleep });
    await expect(up.push(bytes(Q))).rejects.toThrow('keeps failing');
    expect(gcs.ranges.filter((r) => r !== 'bytes */*')).toHaveLength(3);
  });

  it('a session that never moves (never finalises, keeps nothing) is given up on, not looped on', async () => {
    const stuck = (async () => new Response('', { status: 308 })) as unknown as typeof fetch;
    const up = new StreamUpload({ sessionUri: 'u', fetch: stuck, maxRetries: 3, sleep: noSleep });
    await expect(up.push(bytes(Q))).rejects.toThrow('no progress');
    const up2 = new StreamUpload({ sessionUri: 'u', fetch: stuck, maxRetries: 3, sleep: noSleep });
    await up2.push(bytes(10));
    await expect(up2.finish()).rejects.toThrow('no progress');
  });

  it('nothing more once it has finished', async () => {
    const gcs = fakeGcs();
    const up = new StreamUpload({ sessionUri: 'u', fetch: gcs.fetch, sleep: noSleep });
    await up.push(bytes(10));
    await up.finish();
    expect(() => up.push(bytes(10))).toThrow('finished');
  });
});
