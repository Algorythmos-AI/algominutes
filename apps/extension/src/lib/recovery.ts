// A recording the browser closed on (RELEASE.md PR 37d, ADR 0002 §2): the offscreen recorder is gone, but
// Cloud Storage holds what was uploaded before, up to the last few seconds. Next time the extension starts,
// or its popup opens, that much is finalised and saved as a note, as a Stop would have. If the browser
// closing signed the extension out (its session lives in memory only), saving waits until it's connected
// again.
import { heldBytes } from './stream-upload';
import { idToken } from './session';
import { readRecording, saveNote, writeRecording, UNFINISHED, WORDS, type Deps as RecordingDeps, type RecordingState, type Unfinished } from './recording';

export interface Deps extends RecordingDeps {
  /** Whether the offscreen recorder is running (it may be, while the service worker merely restarted). */
  recorderRunning(): Promise<boolean>;
}

/** Opus at the recorder's 64 kbps: enough to say about how long, before the transcoder measures it. */
const BYTES_PER_SECOND = 64_000 / 8;

export async function readUnfinished(deps: Pick<RecordingDeps, 'local'>): Promise<Unfinished | null> {
  return ((await deps.local.get(UNFINISHED))[UNFINISHED] as Unfinished | undefined) ?? null;
}

export type Recovery = 'none' | 'running' | 'signed_out' | RecordingState;

export async function recoverUnfinished(deps: Deps): Promise<Recovery> {
  const u = await readUnfinished(deps);
  if (!u) return 'none';
  if (await deps.recorderRunning()) return 'running';
  if (!(await idToken(deps))) return 'signed_out';

  const rec: RecordingState = {
    ...((await readRecording(deps)) ?? {}),
    phase: 'saving', noteId: u.noteId, workspaceId: u.workspaceId, uploadId: u.uploadId, storagePath: u.storagePath,
    title: u.title, startedAt: u.startedAt, recovered: true,
  };
  await writeRecording(deps, rec);
  const fail = async (error: keyof typeof WORDS) => {
    const failed: RecordingState = { ...rec, phase: 'failed', error: WORDS[error] };
    await writeRecording(deps, failed);
    await deps.local.remove(UNFINISHED);
    await deps.setBadge('');
    return failed;
  };

  try {
    // What Cloud Storage holds, then that much finalised as the whole object.
    const asked = await deps.fetch(u.sessionUri, { method: 'PUT', headers: { 'Content-Range': 'bytes */*' } });
    let held: number;
    if (asked.status === 200 || asked.status === 201) {
      // Already finalised (the recorder finished just as the browser closed): its length is the object's.
      held = Number(((await asked.json()) as { size?: unknown }).size) || 0;
    } else if (asked.status === 308) {
      held = heldBytes(asked.headers.get('Range'));
      if (held === 0) return fail('lost');
      const done = await deps.fetch(u.sessionUri, { method: 'PUT', headers: { 'Content-Range': `bytes */${held}` } });
      if (done.status !== 200 && done.status !== 201) return fail('upload_failed');
    } else {
      // Expired (a week) or gone: nothing can be saved.
      return fail('lost');
    }
    const durationSec = Math.max(1, Math.round(held / BYTES_PER_SECOND));
    return await saveNote(deps, rec, durationSec, fail);
  } catch (err) {
    // silent-catch-ok: the network failing leaves it unfinished, and the next start or popup tries again
    void err;
    await writeRecording(deps, null);
    return 'none';
  }
}
