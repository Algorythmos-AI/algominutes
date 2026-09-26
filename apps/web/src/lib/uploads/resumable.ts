// A file to a GCS resumable upload session (the api mints it: /v1/uploads).
//
// The protocol: PUT each chunk with `Content-Range: bytes <start>-<end>/<total>`.
// GCS answers 308 (more to come) with a `Range: bytes=0-<last>` header saying
// what it has, or 200/201 once the object is complete. A 308 has no Location,
// so fetch hands it back rather than following it. Chunks are multiples of
// 256 KiB (the api's chunkSize is 8 MiB). After a failed chunk, the api is
// asked how many bytes GCS holds (/v1/uploads/:id), and the upload resumes
// from there, as iOS's background uploads do.

export class UploadError extends Error {
  constructor(readonly kind: 'expired' | 'failed' | 'cancelled', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UploadError';
  }
}

export interface ResumableOptions {
  file: Blob;
  sessionUri: string;
  chunkSize: number;
  /** How many bytes GCS already holds (the api's status probe), after a failure. */
  receivedBytes: () => Promise<number>;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Failed chunks in a row before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** GCS's `Range: bytes=0-N` → the next offset (N + 1); no header means it holds nothing yet. */
export function nextOffset(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

const QUANTUM = 256 * 1024;

export async function uploadResumable(opts: ResumableOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = opts.file.size;
  if (total === 0) throw new UploadError('failed', 'That file is empty.');
  // A whole number of 256 KiB units, as GCS requires of every chunk but the last.
  const chunk = Math.max(QUANTUM, Math.floor(opts.chunkSize / QUANTUM) * QUANTUM);
  const maxRetries = opts.maxRetries ?? 5;
  const cancelled = () => new UploadError('cancelled', 'The upload was cancelled.');
  let offset = 0;
  let failures = 0;

  for (;;) {
    if (opts.signal?.aborted) throw cancelled();
    // Every byte is there but GCS hasn't said "complete": ask it to finalise (an empty PUT).
    const finalise = offset >= total;
    const end = Math.min(offset + chunk, total);
    let res: Response | null = null;
    let cause: unknown = null;
    try {
      res = await doFetch(opts.sessionUri, {
        method: 'PUT',
        headers: { 'Content-Range': finalise ? `bytes */${total}` : `bytes ${offset}-${end - 1}/${total}` },
        body: finalise ? null : opts.file.slice(offset, end),
        signal: opts.signal,
        credentials: 'omit',
      });
    } catch (err) {
      if (opts.signal?.aborted) throw cancelled();
      cause = err;
    }
    if (res && (res.status === 200 || res.status === 201)) {
      opts.onProgress?.(total, total);
      return;
    }
    if (res && res.status === 308) {
      const range = res.headers.get('range');
      // No Range after sending bytes: either GCS kept none, or the browser couldn't read the header. The api's
      // probe knows which (it reads GCS server-side), so ask it rather than assume a restart from 0.
      let next = range === null && !finalise ? null : nextOffset(range);
      if (next === null) {
        try {
          next = await opts.receivedBytes();
        } catch (err) {
          cause = err;
          next = offset;
        }
      }
      if (next > offset) {
        failures = 0;
        offset = next;
        opts.onProgress?.(offset, total);
        continue;
      }
      // A 308 that didn't move the offset is a failure too (with a backoff), or a stuck session would loop for ever.
      if (++failures > maxRetries) throw new UploadError('failed', "The upload didn't finish. Try again.", { cause });
      offset = next;
      await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
      continue;
    }
    if (res && (res.status === 404 || res.status === 410)) throw new UploadError('expired', 'This upload expired. Start it again.');
    // No answer, or 5xx, 408, 429: back off, then resume from what GCS holds.
    if (++failures > maxRetries) throw new UploadError('failed', "The upload didn't finish. Check your connection and try again.", { cause });
    await sleep(Math.min(30_000, 1000 * 2 ** (failures - 1)));
    if (opts.signal?.aborted) throw cancelled();
    try {
      offset = await opts.receivedBytes();
      opts.onProgress?.(offset, total);
    } catch (err) {
      // The status probe failed too: keep the offset we had; the next PUT's answer corrects it.
      cause = err;
    }
  }
}
