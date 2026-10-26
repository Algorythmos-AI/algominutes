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
import type { UploadSessionRef } from '../recorder/store';
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

/**
 * `kickoff` is set when the audio uploaded but processing didn't start: retrying
 * that (retryKickoff) processes the same note, where uploading again would make a
 * second note, and a second charge if the first kickoff had in fact gone through.
 */
export type ImportResult =
  | { ok: true; noteId: string }
  | { ok: false; noteId: string | null; message: string; kickoff?: { noteId: string; workspaceId: string; storagePath: string; mimeType: string; durationSec?: number } };

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
  /** A recording made here, not an imported file: its note type and title. */
  recording?: { title: string };
  /**
   * The note an earlier upload of this recording created, cut off before it ended (a tab closed
   * mid-upload): its doc exists, so the audio goes into it rather than a second note. Deleted since
   * (the api answers 404), the recording gets a new note.
   */
  reuseNoteId?: string;
  /**
   * That note's upload session, when it's remembered (RELEASE.md rev 11, LM8): if the server still has it open
   * and the file is the same size, the upload carries on from the bytes Cloud Storage holds.
   */
  reuseSession?: UploadSessionRef;
  /** The note the upload goes into, once it exists: remembered, so a cut-off upload's retry reuses it. */
  onNote?: (noteId: string, session: UploadSessionRef) => void | Promise<unknown>;
  /** The note was deleted again (a cancelled or failed recording upload): nothing to reuse. */
  onNoteDropped?: () => void | Promise<unknown>;
}

export async function importAudio(file: File, deps: ImportDeps): Promise<ImportResult> {
  const problem = importProblem(file);
  if (problem) return { ok: false, noteId: null, message: problem };
  const workspaceId = workspaceIdFor(deps.uid);
  const newNoteId = () => deps.newNoteId?.() ?? `web${crypto.randomUUID().replace(/-/g, '')}`;
  let noteId = deps.reuseNoteId ?? newNoteId();
  let reused = Boolean(deps.reuseNoteId);
  // Remembering the note is the caller's (a recording's entry in IndexedDB): a failure there is reported, not fatal.
  const tell = async (what: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      reportCrash(`import.${what}`, err);
    }
  };
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

  const mint = () => deps.api.createUpload({ noteId, workspaceId, fileName: file.name, contentType: mimeType, totalBytes: file.size });
  let session: Omit<UploadSessionRef, 'totalBytes'> | undefined;
  // Bytes the remembered session already holds: the upload starts there.
  let startAt = 0;
  let resumed = false;
  try {
    const kept = reused && deps.reuseSession && deps.reuseSession.totalBytes === file.size ? deps.reuseSession : null;
    if (kept) {
      try {
        const status = await deps.api.uploadStatus(kept.uploadId);
        session = { uploadId: kept.uploadId, sessionUri: kept.sessionUri, chunkSize: kept.chunkSize, storagePath: kept.storagePath };
        startAt = status.complete ? file.size : Math.min(status.receivedBytes, file.size);
        resumed = true;
      } catch (err) {
        // silent-catch-ok: a session the server no longer has (expired, or its note gone) can't be resumed; a new one is minted below, and that call reports any real failure
        if (!(err instanceof ApiError)) reportCrash('import.resumeStatus', err);
      }
    }
    try {
      session = session ?? (await mint());
    } catch (err) {
      // silent-catch-ok: the note to reuse was deleted since (its tombstone refuses uploads), so the recording gets a new one; anything else is rethrown
      if (!(reused && err instanceof ApiError && err.kind === 'not_found')) throw err;
      await tell('onNoteDropped', () => deps.onNoteDropped?.());
      noteId = newNoteId();
      reused = false;
      session = await mint();
    }
  } catch (err) {
    // Nothing new exists yet: no note to mark. The client makes every failure an ApiError: anything else is a bug.
    if (!(err instanceof ApiError)) reportCrash('import.createUpload', err);
    return { ok: false, noteId: null, message: err instanceof ApiError ? err.message : "The upload couldn't start. Try again." };
  }

  if (deps.signal?.aborted) return cancelled();
  const type = deps.recording ? 'recording' : 'import_audio';
  if (!reused) {
    try {
      await deps.createNoteDoc({ noteId, uid: deps.uid, title: deps.recording?.title ?? titleFrom(file.name), type, mimeType, storagePath: session.storagePath, ...(duration ? { duration } : {}) });
    } catch (err) {
      // No doc, no note: stop before uploading (the minted session just expires).
      reportCrash('import.createNoteDoc', err);
      return { ok: false, noteId: null, message: "The upload couldn't start. Try again." };
    }
  }
  // A reused note's doc is already there, with this same storage path (recordings/{ws}/{noteId}.{ext}).
  const sessionRef: UploadSessionRef = { uploadId: session.uploadId, sessionUri: session.sessionUri, chunkSize: session.chunkSize, storagePath: session.storagePath, totalBytes: file.size };
  await tell('onNote', () => deps.onNote?.(noteId, sessionRef));
  deps.track?.start(noteId);

  const mark = async (message: string) => {
    try {
      await deps.markNoteFailed(noteId, message);
    } catch (err) {
      // The note stays 'processing' until the watchdog calls it slow; the user still sees the message now.
      reportCrash('import.markNoteFailed', err);
    }
  };
  const fail = async (message: string): Promise<ImportResult> => {
    // The note stays, marked failed, for a recording as for an imported file (RELEASE.md rev 11, LM8; the
    // owner's choice, 2026-10-01). A recording's note used to be deleted, so Try again made a new note and a new
    // session and sent a 2-hour recording again from the first byte. Kept, with its session remembered (onNote),
    // Try again carries on from the bytes Cloud Storage holds. Discarding the recording deletes its note.
    await mark(message);
    return { ok: false, noteId, message };
  };

  try {
    const send = (to: Omit<UploadSessionRef, 'totalBytes'>, from: number) => uploadResumable({
      file,
      sessionUri: to.sessionUri,
      chunkSize: to.chunkSize,
      startAt: from,
      receivedBytes: async () => (await deps.api.uploadStatus(to.uploadId)).receivedBytes,
      onProgress: (sent, total) => deps.onProgress?.(sent / total),
      signal: deps.signal,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
    });
    try {
      await send(session, startAt);
    } catch (err) {
      // silent-catch-ok: a remembered session Cloud Storage has let go of can't be resumed: a new one is minted and the recording sent from the start, once; any other failure is rethrown to the handler below
      if (!(resumed && err instanceof UploadError && err.kind === 'expired')) throw err;
      session = await mint();
      const fresh: UploadSessionRef = { uploadId: session.uploadId, sessionUri: session.sessionUri, chunkSize: session.chunkSize, storagePath: session.storagePath, totalBytes: file.size };
      await tell('onNote', () => deps.onNote?.(noteId, fresh));
      await send(session, 0);
    }
    deps.onUploaded?.();
    await deps.api.completeUpload(session.uploadId);
  } catch (err) {
    // silent-catch-ok: a cancelled upload is the user's choice, and its note is deleted
    if (err instanceof UploadError && err.kind === 'cancelled') {
      // Cancelled: the note goes, rather than staying behind as a failure the user has to delete.
      try {
        await deps.api.deleteNote({ noteId, workspaceId });
        await tell('onNoteDropped', () => deps.onNoteDropped?.());
      } catch (delErr) {
        reportCrash('import.cancelDelete', delErr);
        await mark('The upload was cancelled.');
      }
      deps.track?.end(noteId);
      return cancelled();
    }
    if (!(err instanceof UploadError || err instanceof ApiError)) reportCrash('import.upload', err);
    deps.track?.end(noteId);
    return fail(err instanceof UploadError || err instanceof ApiError ? err.message : "The upload didn't finish. Try again.");
  }

  try {
    await deps.api.process({ noteId, workspaceId, type, storagePath: session.storagePath, mimeType, ...(duration ? { durationSec: duration } : {}) });
  } catch (err) {
    const f = kickoffFailure(err, "Your recording uploaded, but processing couldn't start. Try again.");
    const onNote = noteError(f);
    if (onNote) await mark(onNote);
    deps.track?.end(noteId);
    return { ok: false, noteId, message: failureMessage(f), kickoff: { noteId, workspaceId, storagePath: session.storagePath, mimeType, ...(duration ? { durationSec: duration } : {}) } };
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

/**
 * Processes a recording's note whose audio is already uploaded (ImportResult.kickoff).
 * The server answers a note that's ready, or already queued, without starting
 * (or charging) it again.
 */
export async function retryKickoff(
  api: Pick<ApiClient, 'process'>,
  k: NonNullable<Extract<ImportResult, { ok: false }>['kickoff']>,
): Promise<ImportResult> {
  try {
    await api.process({ noteId: k.noteId, workspaceId: k.workspaceId, type: 'recording', storagePath: k.storagePath, mimeType: k.mimeType, ...(k.durationSec ? { durationSec: k.durationSec } : {}) });
    return { ok: true, noteId: k.noteId };
  } catch (err) {
    return { ok: false, noteId: k.noteId, message: failureMessage(kickoffFailure(err, "Processing couldn't start. Try again.")), kickoff: k };
  }
}

