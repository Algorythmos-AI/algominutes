import { describe, it, expect } from 'vitest';
import { recoverUnfinished } from './recovery';
import { readRecording, WORDS, type Unfinished } from './recording';
import { saveSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor, type Call } from './testing';

const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=x';
const U: Unfinished = { uploadId: 'up-1', sessionUri: SESSION, noteId: 'note-1', workspaceId: 'workspace_alice', storagePath: 'recordings/workspace_alice/note-1.webm', title: 'Call, 30 Sep', startedAt: 1_000 };

/** Cloud Storage holding `held` bytes of the session (or answering `status`), and the api taking the rest. */
function world(opts: { held?: number; status?: number; final?: number; api?: (c: Call) => Response | undefined; running?: boolean; net?: boolean } = {}) {
  const storage = fakeStorage();
  const local = fakeStorage();
  const net = fakeFetch((c) => {
    if (c.url === SESSION) {
      if (opts.net) throw new TypeError('Failed to fetch');
      const range = c.headers['Content-Range'];
      if (range === 'bytes */*') {
        if (opts.status) return new Response(opts.status === 200 ? JSON.stringify({ size: String(opts.held ?? 0) }) : '', { status: opts.status });
        return new Response('', { status: 308, headers: opts.held ? { Range: `bytes=0-${opts.held - 1}` } : {} });
      }
      return new Response('{}', { status: opts.final ?? (range === `bytes */${opts.held}` ? 200 : 400) });
    }
    const custom = opts.api?.(c);
    if (custom) return custom;
    return json(200, { ok: true });
  });
  const log: string[] = [];
  const deps = {
    storage, local, fetch: net.fetch, now: () => 5_000,
    recorderRunning: async () => opts.running ?? false,
    streamIdFor: async () => 's', toOffscreen: async () => ({ ok: true }), closeOffscreen: async () => {},
    setBadge: async (t: string) => { log.push(`badge:${t}`); }, newNoteId: () => 'n',
  };
  return { deps, local, calls: net.calls, log };
}
const signIn = (w: ReturnType<typeof world>) => saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r', expiresIn: 3600 });
const api = (calls: Call[]) => calls.filter((c) => c.url !== SESSION).map((c) => `${c.method} ${new URL(c.url).pathname}`);

describe('a recording the browser closed on', () => {
  it('nothing unfinished: nothing to do', async () => {
    const w = world();
    await signIn(w);
    expect(await recoverUnfinished(w.deps)).toBe('none');
    expect(w.calls).toHaveLength(0);
  });

  it('while the recorder is still running (the service worker only restarted), it\'s left alone', async () => {
    const w = world({ held: 1000, running: true });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toBe('running');
    expect(w.calls).toHaveLength(0);
    expect(w.local.data.has('unfinished')).toBe(true);
  });

  it('signed out (the browser closing ends the session): it waits, kept, for the extension to be connected again', async () => {
    const w = world({ held: 1000 });
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toBe('signed_out');
    expect(w.calls).toHaveLength(0);
    expect(w.local.data.has('unfinished')).toBe(true);
  });

  it('what Cloud Storage holds is finalised and saved as the note, as a Stop would have', async () => {
    const held = 8000 * 1234;
    const w = world({ held });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toMatchObject({ phase: 'saved', noteId: 'note-1', recovered: true });
    expect(w.calls.filter((c) => c.url === SESSION).map((c) => c.headers['Content-Range'])).toEqual(['bytes */*', `bytes */${held}`]);
    expect(api(w.calls)).toEqual(['POST /v1/uploads/up-1/complete', 'POST /v1/notes', 'POST /v1/process']);
    expect(JSON.parse(w.calls.find((c) => c.url.endsWith('/v1/notes'))!.body!)).toEqual({ uploadId: 'up-1', title: 'Call, 30 Sep', type: 'recording', mimeType: 'audio/webm', durationSec: 1234 });
    expect(JSON.parse(w.calls.find((c) => c.url.endsWith('/v1/process'))!.body!)).toMatchObject({ noteId: 'note-1', workspaceId: 'workspace_alice', storagePath: U.storagePath });
    expect(w.local.data.has('unfinished')).toBe(false);
    expect(await readRecording(w.deps)).toMatchObject({ phase: 'saved', recovered: true });
  });

  it('already finalised (the last chunk went just as it closed): saved as it is', async () => {
    const w = world({ status: 200, held: 16000 });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toMatchObject({ phase: 'saved' });
    expect(w.calls.filter((c) => c.url === SESSION)).toHaveLength(1);
    expect(JSON.parse(w.calls.find((c) => c.url.endsWith('/v1/notes'))!.body!).durationSec).toBe(2);
  });

  it('nothing uploaded, or the session gone: lost, said so, and forgotten; no note', async () => {
    for (const opts of [{ held: 0 }, { status: 404 }, { status: 410 }]) {
      const w = world(opts);
      await signIn(w);
      await w.local.set({ unfinished: U });
      expect(await recoverUnfinished(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.lost });
      expect(api(w.calls)).toEqual([]);
      expect(w.local.data.has('unfinished')).toBe(false);
    }
  });

  it('Cloud Storage refusing to finalise: failed, and no note', async () => {
    const w = world({ held: 1000, final: 400 });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.upload_failed });
    expect(api(w.calls)).toEqual([]);
  });

  it('out of minutes when saving: failed with the words, and forgotten', async () => {
    const w = world({ held: 1000, api: (c) => (c.url.endsWith('/v1/process') ? json(402, {}) : undefined) });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.no_minutes });
    expect(w.local.data.has('unfinished')).toBe(false);
  });

  it('the network failing: kept for the next try, and not left saving', async () => {
    const w = world({ net: true });
    await signIn(w);
    await w.local.set({ unfinished: U });
    expect(await recoverUnfinished(w.deps)).toBe('none');
    expect(w.local.data.has('unfinished')).toBe(true);
    expect(await readRecording(w.deps)).toBeNull();
  });
});
