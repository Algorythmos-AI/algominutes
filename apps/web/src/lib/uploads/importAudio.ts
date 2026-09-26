// Importing an audio file, as iOS does (UploadService + NotesRepository):
//   1. /v1/uploads mints a resumable session and the note's storage path;
//   2. the note's doc is written ('processing'), so the list shows it at once;
//   3. the bytes go straight to GCS, resuming from the server's offset;
//   4. /v1/uploads/:id/complete, then /v1/process kicks the pipeline off.
// A failure before the server owns the note marks it failed with a message,
// unless the server already did (a 413 or 429 kickoff).
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { reportCrash } from '../crashReport';
import type { NewNote } from '../notes/noteCache';
import { workspaceIdFor } from '../notes/workspace';
import { failureMessage, kickoffFailure, noteError } from './kickoff';
import { UploadError, uploadResumable } from './resumable';

/** The api's cap (packages/ai intelligence.cjs MAX_AUDIO_BYTES), checked first so nothing is uploaded in vain. */
export const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

// What the pipeline can send to Gemini as it is (packages/ai intelligence.cjs
// resolveGeminiAudioMime): anything else would be mislabelled, charged, and fail.
const AUDIO_EXT = /\.(m4a|mp4|aac|mp3|wav|flac|ogg|oga|opus|webm)$/i;
const AUDIO_MIME = /^audio\/(mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|wave|flac|x-flac|ogg|opus|webm)$/i;

export function importProblem(file: File): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_IMPORT_BYTES) return 'That file is too large. The limit is 500 MB.';
  if (!AUDIO_EXT.test(file.name) && !AUDIO_MIME.test(file.type)) return 'That format isn’t supported. Use M4A, MP3, WAV, FLAC, OGG, Opus or WebM audio.';
  return null;
}

export const titleFrom = (fileName: string) => fileName.replace(/\.[^.]+$/, '').trim().slice(0, 300) || 'Imported recording';

export type ImportResult = { ok: true; noteId: string } | { ok: false; noteId: string | null; message: string };

export interface ImportDeps {
  api: Pick<ApiClient, 'entitlement' | 'createUpload' | 'uploadStatus' | 'completeUpload' | 'process' | 'deleteNote'>;
  uid: string;
  createNoteDoc: (n: NewNote) => Promise<void>;
  markNoteFailed: (noteId: string, message: string) => Promise<void>;
  /** Seconds, or null when the browser can't read it (the server measures it anyway). */
  probeDuration: (file: File) => Promise<number | null>;
  newNoteId?: () => string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (fraction: number) => void;
  /** Called once the bytes are all sent: from here the import can't be cancelled. */
  onUploaded?: () => void;
  signal?: AbortSignal;
  /** Records the upload as this browser's (ownUploads.ts), so a closed tab's is cleaned up. */
  track?: { start: (noteId: string) => void; end: (noteId: string) => void };
}

export async function importAudio(file: File, deps: ImportDeps): Promise<ImportResult> {
  const problem = importProblem(file);
  if (problem) return { ok: false, noteId: null, message: problem };
  const workspaceId = workspaceIdFor(deps.uid);
  const noteId = deps.newNoteId?.() ?? `web${crypto.randomUUID().replace(/-/g, '')}`;
  const mimeType = file.type || 'application/octet-stream';
  const cancelled = (): ImportResult => ({ ok: false, noteId: null, message: 'The upload was cancelled.' });

  // Spent minutes are refused at the kickoff; say so before up to 500 MB is uploaded in vain.
  try {
    const e = await deps.api.entitlement();
    if (e.overQuota) return { ok: false, noteId: null, message: failureMessage({ kind: 'quota', entitlement: e }) };
  } catch (err) {
    // The kickoff still checks: carry on.
    reportCrash('import.entitlement', err);
  }
  if (deps.signal?.aborted) return cancelled();
  const duration = await deps.probeDuration(file);
  if (deps.signal?.aborted) return cancelled();

  let session;
  try {
    session = await deps.api.createUpload({ noteId, workspaceId, fileName: file.name, contentType: mimeType, totalBytes: file.size });
  } catch (err) {
    // Nothing exists yet: no note to mark.
    return { ok: false, noteId: null, message: err instanceof ApiError ? err.message : "The upload couldn't start. Try again." };
  }

  if (deps.signal?.aborted) return cancelled();
  try {
    await deps.createNoteDoc({ noteId, uid: deps.uid, title: titleFrom(file.name), type: 'import_audio', mimeType, storagePath: session.storagePath, ...(duration ? { duration } : {}) });
    deps.track?.start(noteId);
  } catch (err) {
    // No doc, no note: stop before uploading (the minted session just expires).
    reportCrash('import.createNoteDoc', err);
    return { ok: false, noteId: null, message: "The upload couldn't start. Try again." };
  }

  const mark = async (message: string) => {
    try {
      await deps.markNoteFailed(noteId, message);
    } catch (err) {
      // The note stays 'processing' until the watchdog calls it slow; the user still sees the message now.
      reportCrash('import.markNoteFailed', err);
    }
  };
  const fail = async (message: string): Promise<ImportResult> => {
    await mark(message);
    return { ok: false, noteId, message };
  };

  try {
    await uploadResumable({
      file,
      sessionUri: session.sessionUri,
      chunkSize: session.chunkSize,
      receivedBytes: async () => (await deps.api.uploadStatus(session.uploadId)).receivedBytes,
      onProgress: (sent, total) => deps.onProgress?.(sent / total),
      signal: deps.signal,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
    deps.onUploaded?.();
    await deps.api.completeUpload(session.uploadId);
  } catch (err) {
    if (err instanceof UploadError && err.kind === 'cancelled') {
      // Cancelled: the note goes, rather than staying behind as a failure the user has to delete.
      try {
        await deps.api.deleteNote({ noteId, workspaceId });
      } catch (delErr) {
        reportCrash('import.cancelDelete', delErr);
        await mark('The upload was cancelled.');
      }
      deps.track?.end(noteId);
      return cancelled();
    }
    deps.track?.end(noteId);
    return fail(err instanceof UploadError || err instanceof ApiError ? err.message : "The upload didn't finish. Try again.");
  }

  try {
    await deps.api.process({ noteId, workspaceId, type: 'import_audio', storagePath: session.storagePath, mimeType, ...(duration ? { durationSec: duration } : {}) });
  } catch (err) {
    const f = kickoffFailure(err, "Your recording uploaded, but processing couldn't start. Try again.");
    const onNote = noteError(f);
    if (onNote) await mark(onNote);
    deps.track?.end(noteId);
    return { ok: false, noteId, message: failureMessage(f) };
  }
  // The server owns the note now.
  deps.track?.end(noteId);
  return { ok: true, noteId };
}

/** The file's length from the browser's own decoder (metadata only), or null after 10 seconds or on any error. */
export function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('audio');
    const done = (v: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 10_000);
    el.preload = 'metadata';
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}
