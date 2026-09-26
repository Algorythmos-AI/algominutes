// Recording from the microphone in the browser: MediaRecorder, one chunk every
// few seconds straight into RecordingStore (store.ts), so nothing is held only
// in memory. The formats are the ones the pipeline sends to Gemini as they are
// (packages/ai intelligence.cjs): WebM/Opus where it's supported (Chromium,
// Firefox), MP4/AAC otherwise (Safari).
import type { RecordingStore } from './store';

export const CHUNK_MS = 5000;

const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

/** The first format this browser can record, or null when it can't record audio at all. */
export function pickMimeType(isTypeSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)): string | null {
  return PREFERRED.find((t) => isTypeSupported(t)) ?? null;
}

/** The file extension the api stores it under (routes/uploads.js reads it from the name). */
export const extensionFor = (mimeType: string) => (mimeType.startsWith('audio/mp4') ? 'm4a' : 'webm');

export interface ActiveRecording {
  id: string;
  mimeType: string;
  /** Resolves once the last chunk is safely stored. */
  stop(): Promise<void>;
}

export interface StartOptions {
  id: string;
  uid: string;
  stream: MediaStream;
  store: RecordingStore;
  mimeType: string;
  /** A chunk couldn't be stored (a full disk): the recording must stop. */
  onStoreError: (err: unknown) => void;
  now?: () => number;
  Recorder?: typeof MediaRecorder;
}

export async function startRecording(o: StartOptions): Promise<ActiveRecording> {
  const now = o.now ?? Date.now;
  const Rec = o.Recorder ?? MediaRecorder;
  const startedAt = now();
  await o.store.create({ id: o.id, uid: o.uid, mimeType: o.mimeType, startedAt, seconds: 0 });
  const rec = new Rec(o.stream, { mimeType: o.mimeType, audioBitsPerSecond: 64_000 });
  let seq = 0;
  let writes = Promise.resolve();
  rec.ondataavailable = (e: BlobEvent) => {
    if (!e.data || e.data.size === 0) return;
    const n = seq++;
    const seconds = (now() - startedAt) / 1000;
    // In order, one at a time: the chunks' order is the audio's.
    writes = writes.then(() => o.store.append(o.id, n, e.data, seconds)).catch((err: unknown) => {
      o.onStoreError(err);
    });
  };
  rec.start(CHUNK_MS);
  return {
    id: o.id,
    mimeType: o.mimeType,
    stop: () =>
      new Promise<void>((resolve) => {
        rec.onstop = () => {
          o.stream.getTracks().forEach((t) => t.stop());
          void writes.then(() => o.store.stop(o.id)).then(resolve, (err: unknown) => {
            o.onStoreError(err);
            resolve();
          });
        };
        if (rec.state === 'inactive') rec.onstop(new Event('stop'));
        else rec.stop();
      }),
  };
}
