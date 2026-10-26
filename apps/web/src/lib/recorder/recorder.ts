// Recording from the microphone in the browser: MediaRecorder, one chunk every
// few seconds straight into RecordingStore (store.ts), so nothing is held only
// in memory. The formats are the ones the pipeline sends to Gemini as they are
// (packages/ai intelligence.cjs): WebM/Opus where it's supported (Chromium,
// Firefox), MP4/AAC otherwise (Safari).
//
// While it records, a recording holds a Web Lock named for it, so another tab
// (or this one, reloaded) can tell a recording still being made from one left
// behind (leftOver below), and never offers to upload or discard a live one.
import type { RecordingMeta, RecordingStore } from './store';

export const CHUNK_MS = 5000;

const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

/** The first format this browser can record, or null when it can't record audio at all. */
export function pickMimeType(isTypeSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)): string | null {
  return PREFERRED.find((t) => isTypeSupported(t)) ?? null;
}

/** The file extension the api stores it under (routes/uploads.js reads it from the name). */
export const extensionFor = (mimeType: string) => (mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm');

export type Locks = Pick<LockManager, 'request' | 'query'>;
const LOCK_PREFIX = 'algominutes-recording:';
const browserLocks = (): Locks | null => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null);
/** Without Web Locks: a recording written to this recently, and not stopped, may be live in another tab. */
export const LIVE_WITHOUT_LOCKS_MS = 30_000;

/**
 * The recordings that are left over (a closed tab, a failed upload), not ones
 * some tab of this browser is still making. With Web Locks that's exact; without
 * them, a recording touched in the last 30 seconds counts as live.
 */
export async function leftOver(all: RecordingMeta[], locks: Locks | null = browserLocks(), now = Date.now()): Promise<RecordingMeta[]> {
  if (locks) {
    const { held = [] } = await locks.query();
    const live = new Set(held.map((l) => l.name ?? '').filter((n) => n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
    return all.filter((r) => !live.has(r.id));
  }
  return all.filter((r) => r.stoppedAt !== undefined || r.touchedAt === undefined || now - r.touchedAt >= LIVE_WITHOUT_LOCKS_MS);
}

/** The recording's entry was removed while it was being made: its audio has nowhere to go. */
export class RecordingGoneError extends Error {
  constructor() {
    super('This recording was removed from this browser while it was being made.');
    this.name = 'RecordingGoneError';
  }
}

export interface ActiveRecording {
  id: string;
  mimeType: string;
  /** Resolves once the last chunk is safely stored; rejects with RecordingGoneError when the recording was removed. */
  stop(): Promise<void>;
}

export interface StartOptions {
  id: string;
  uid: string;
  stream: MediaStream;
  store: RecordingStore;
  mimeType: string;
  /** A chunk couldn't be stored (a full disk, or the recording was removed): the recording must stop. */
  onStoreError: (err: unknown) => void;
  /**
   * The recording stopped capturing by itself: the microphone was unplugged or
   * its permission taken away, or the recorder failed. What's stored is kept; the
   * page stops and saves it. Once at most, and never after stop().
   */
  onInterrupted?: () => void;
  /** Seconds recorded, after each stored chunk: the cap is checked here too, as a hidden tab's timers are throttled. */
  onProgress?: (seconds: number) => void;
  /** The tracks whose end means nothing more is captured (default: the stream's). */
  watch?: MediaStreamTrack[];
  now?: () => number;
  Recorder?: typeof MediaRecorder;
  locks?: Locks | null;
}

/** Holds this recording's lock until `release` is called; resolves once it's held. */
async function holdLock(locks: Locks, id: string): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((acquired, fail) => {
    locks.request(`${LOCK_PREFIX}${id}`, () => {
      acquired();
      return held;
    }).catch(fail);
  });
  return release;
}

export async function startRecording(o: StartOptions): Promise<ActiveRecording> {
  const now = o.now ?? Date.now;
  const Rec = o.Recorder ?? MediaRecorder;
  const locks = o.locks === undefined ? browserLocks() : o.locks;
  const startedAt = now();
  const release = locks ? await holdLock(locks, o.id) : () => {};
  let rec: MediaRecorder;
  try {
    await o.store.create({ id: o.id, uid: o.uid, mimeType: o.mimeType, startedAt, seconds: 0, touchedAt: startedAt });
    rec = new Rec(o.stream, { mimeType: o.mimeType, audioBitsPerSecond: 64_000 });
  } catch (err) {
    // Nothing was recorded: leave no empty "0:00 (cut off)" entry behind.
    await o.store.remove(o.id).catch((removeErr: unknown) => o.onStoreError(removeErr));
    release();
    throw err;
  }
  let seq = 0;
  let writes = Promise.resolve();
  let stopping = false;
  let interrupted = false;
  const interrupt = () => {
    if (stopping || interrupted) return;
    interrupted = true;
    o.onInterrupted?.();
  };
  rec.ondataavailable = (e: BlobEvent) => {
    if (!e.data || e.data.size === 0) return;
    const n = seq++;
    const seconds = (now() - startedAt) / 1000;
    // In order, one at a time: the chunks' order is the audio's.
    writes = writes
      .then(async () => {
        if (!(await o.store.append(o.id, n, e.data, seconds, now()))) throw new RecordingGoneError();
        o.onProgress?.(seconds);
      })
      .catch((err: unknown) => {
        o.onStoreError(err);
      });
  };
  rec.onerror = () => interrupt();
  // A stop nobody asked for: every track ended, and the recorder with them.
  rec.addEventListener('stop', () => interrupt());
  for (const t of o.watch ?? o.stream.getTracks()) t.addEventListener('ended', () => interrupt());
  try {
    rec.start(CHUNK_MS);
  } catch (err) {
    await o.store.remove(o.id).catch((removeErr: unknown) => o.onStoreError(removeErr));
    release();
    throw err;
  }
  return {
    id: o.id,
    mimeType: o.mimeType,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        stopping = true;
        rec.onstop = () => {
          o.stream.getTracks().forEach((t) => t.stop());
          void writes
            .then(() => o.store.stop(o.id))
            .then(
              (kept) => (kept ? resolve() : reject(new RecordingGoneError())),
              (err: unknown) => {
                o.onStoreError(err);
                resolve();
              },
            )
            .finally(release);
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      }),
  };
}
