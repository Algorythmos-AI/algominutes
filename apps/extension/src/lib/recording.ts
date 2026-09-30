// A recording of the meeting tab, run by the service worker (RELEASE.md PR 37b, ADR 0002 §1-2).
//
// Start (from the popup, after the consent ticks): a tab-capture stream id for the tab the popup was opened
// on; an upload session with no length yet (POST /v1/uploads, PR 33a) under a new note id; then the
// offscreen document records the tab and the microphone into that session while the meeting runs.
// Stop (the popup, or the tab closing): the offscreen document sends the rest; then the upload is completed,
// the note made (POST /v1/notes, PR 35) and kicked off (POST /v1/process), as the web does for a recording.
// Where it stands lives in chrome.storage.session, so the popup can show it.
import { apiFetch, type Fetch } from './http';
import { idToken, readSession, type Deps as SessionDeps } from './session';

export type Phase = 'recording' | 'saving' | 'saved' | 'failed';

export interface RecordingState {
  phase: Phase;
  noteId: string;
  workspaceId: string;
  uploadId: string;
  storagePath: string;
  title: string;
  startedAt: number;
  micIncluded?: boolean;
  /** Saved after the browser closed mid-recording, from what had been uploaded (37d). */
  recovered?: boolean;
  /** Why it failed, in words the popup shows. */
  error?: string;
}

/**
 * What it takes to finish a recording after the browser closed mid-way (lib/recovery.ts, 37d), kept in
 * chrome.storage.local from its start until it's saved or has failed. The session URI can write that one
 * object, for a week; nothing else is in it.
 */
export interface Unfinished {
  uploadId: string;
  sessionUri: string;
  noteId: string;
  workspaceId: string;
  storagePath: string;
  title: string;
  startedAt: number;
}
export const UNFINISHED = 'unfinished';

export interface OffscreenAnswer {
  ok: boolean;
  error?: string;
  durationSec?: number;
  micIncluded?: boolean;
}

export interface Deps extends SessionDeps {
  fetch: Fetch;
  /** chrome.storage.local: only the unfinished recording (above), to outlive the browser. */
  local: chrome.storage.StorageArea;
  /** chrome.tabCapture.getMediaStreamId for the tab. */
  streamIdFor(tabId: number): Promise<string>;
  /** Creates the offscreen document if it isn't there, then sends it a message and waits for its answer. */
  toOffscreen(message: { type: 'start'; streamId: string; sessionUri: string; chunkSize: number } | { type: 'stop' }): Promise<OffscreenAnswer>;
  closeOffscreen(): Promise<void>;
  setBadge(text: string): Promise<void>;
  newNoteId(): string;
}

const KEY = 'recording';

export const WORDS = {
  signed_out: 'Connect the extension to your AlgoMinutes account first.',
  busy: 'A recording is already running.',
  please_update: 'This version of the extension is out of date. Update it, then try again.',
  capture_failed: 'Chrome didn’t let the extension record this tab. Open the extension from the meeting’s tab and try again.',
  upload_refused: 'AlgoMinutes couldn’t start the recording. Try again.',
  upload_failed: 'The recording couldn’t be uploaded. Check your connection.',
  no_minutes: 'You’re out of recording minutes. The recording is kept: add minutes on the AlgoMinutes web app, then try it again from the note.',
  save_failed: 'The recording was uploaded but couldn’t be saved as a note. Try again from the AlgoMinutes web app.',
  lost: 'The browser closed before any of the recording was uploaded, so there was nothing to save.',
} as const;

export async function readRecording(deps: SessionDeps): Promise<RecordingState | null> {
  return ((await deps.storage.get(KEY))[KEY] as RecordingState | undefined) ?? null;
}

export async function writeRecording(deps: SessionDeps, state: RecordingState | null): Promise<void> {
  return write(deps, state);
}

async function write(deps: SessionDeps, state: RecordingState | null): Promise<void> {
  if (state) await deps.storage.set({ [KEY]: state });
  else await deps.storage.remove(KEY);
}

export type Answer = { ok: true } | { ok: false; error: keyof typeof WORDS };

export async function startRecording(deps: Deps, input: { tabId: number; title: string }): Promise<Answer> {
  const now = await readRecording(deps);
  if (now && (now.phase === 'recording' || now.phase === 'saving')) return { ok: false, error: 'busy' };
  const token = await idToken(deps);
  const session = await readSession(deps);
  if (!token || !session) return { ok: false, error: 'signed_out' };

  // First, while the user's click still counts: Chrome grants a tab's stream id only to an invoked extension.
  let streamId: string;
  try {
    streamId = await deps.streamIdFor(input.tabId);
  } catch (err) {
    // silent-catch-ok: Chrome refusing the capture is the answer capture_failed, which the popup shows
    void err;
    return { ok: false, error: 'capture_failed' };
  }

  const noteId = deps.newNoteId();
  const workspaceId = `workspace_${session.uid}`;
  const res = await apiFetch(deps.fetch, '/v1/uploads', {
    method: 'POST',
    idToken: token,
    body: { noteId, workspaceId, fileName: 'recording.webm', contentType: 'audio/webm' },
  });
  if (res.status === 426) return { ok: false, error: 'please_update' };
  if (!res.ok) return { ok: false, error: 'upload_refused' };
  const up = (await res.json()) as { uploadId?: unknown; sessionUri?: unknown; storagePath?: unknown; chunkSize?: unknown };
  if (typeof up.uploadId !== 'string' || typeof up.sessionUri !== 'string' || typeof up.storagePath !== 'string') {
    return { ok: false, error: 'upload_refused' };
  }

  const started = await deps.toOffscreen({ type: 'start', streamId, sessionUri: up.sessionUri, chunkSize: Number(up.chunkSize) || 8 * 1024 * 1024 });
  if (!started.ok) {
    await deps.closeOffscreen();
    return { ok: false, error: 'capture_failed' };
  }
  const startedAt = deps.now();
  const unfinished: Unfinished = { uploadId: up.uploadId, sessionUri: up.sessionUri, noteId, workspaceId, storagePath: up.storagePath, title: input.title, startedAt };
  await deps.local.set({ [UNFINISHED]: unfinished });
  await write(deps, {
    phase: 'recording', noteId, workspaceId, uploadId: up.uploadId, storagePath: up.storagePath,
    title: input.title, startedAt, micIncluded: started.micIncluded,
  });
  await deps.setBadge('REC');
  return { ok: true };
}

/**
 * Stop and save. Safe to call twice (the popup's Stop and the tab closing): only a running recording is
 * stopped. The note's minutes are checked at its kickoff, as on the web; a recording refused there is kept.
 */
export async function stopRecording(deps: Deps): Promise<RecordingState | null> {
  const rec = await readRecording(deps);
  if (!rec || rec.phase !== 'recording') return rec;
  await write(deps, { ...rec, phase: 'saving' });
  const fail = async (error: keyof typeof WORDS) => {
    const failed: RecordingState = { ...rec, phase: 'failed', error: WORDS[error] };
    await write(deps, failed);
    await deps.local.remove(UNFINISHED);
    await deps.setBadge('');
    await deps.closeOffscreen();
    return failed;
  };

  try {
    return await save(deps, rec, fail);
  } catch (err) {
    // silent-catch-ok: whatever broke (the network, the offscreen document), the recording ends as failed with words the popup shows, not stuck saving
    void err;
    return fail('save_failed');
  }
}

async function save(deps: Deps, rec: RecordingState, fail: (error: keyof typeof WORDS) => Promise<RecordingState>): Promise<RecordingState> {
  const stopped = await deps.toOffscreen({ type: 'stop' });
  if (!stopped.ok) return fail('upload_failed');
  const durationSec = Math.max(1, Math.round(stopped.durationSec ?? (deps.now() - rec.startedAt) / 1000));
  await deps.closeOffscreen();
  return saveNote(deps, { ...rec, micIncluded: stopped.micIncluded ?? rec.micIncluded }, durationSec, fail);
}

/**
 * An uploaded recording becomes a note: the upload completed, the note made, and kicked off. Shared by Stop
 * and by recovery after the browser closed (lib/recovery.ts).
 */
export async function saveNote(
  deps: Deps,
  rec: RecordingState,
  durationSec: number,
  fail: (error: keyof typeof WORDS) => Promise<RecordingState>,
): Promise<RecordingState> {
  const token = await idToken(deps);
  if (!token) return fail('signed_out');
  const post = (path: string, body?: unknown) => apiFetch(deps.fetch, path, { method: 'POST', idToken: token, body: body ?? {} });

  if (!(await post(`/v1/uploads/${encodeURIComponent(rec.uploadId)}/complete`)).ok) return fail('upload_failed');
  const made = await post('/v1/notes', { uploadId: rec.uploadId, title: rec.title, type: 'recording', mimeType: 'audio/webm', durationSec });
  if (!made.ok) return fail('save_failed');
  const kicked = await post('/v1/process', {
    noteId: rec.noteId, workspaceId: rec.workspaceId, type: 'recording', storagePath: rec.storagePath, durationSec,
  });
  if (kicked.status === 402) return fail('no_minutes');
  if (!kicked.ok) return fail('save_failed');

  const saved: RecordingState = { ...rec, phase: 'saved' };
  await write(deps, saved);
  await deps.local.remove(UNFINISHED);
  await deps.setBadge('');
  return saved;
}

/** The popup's Done: forget a saved or failed recording. A running one is never forgotten. */
export async function dismissRecording(deps: SessionDeps): Promise<void> {
  const rec = await readRecording(deps);
  if (rec && (rec.phase === 'saved' || rec.phase === 'failed')) await write(deps, null);
}
