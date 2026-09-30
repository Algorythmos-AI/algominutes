import { describe, it, expect } from 'vitest';
import { startRecording, stopRecording, dismissRecording, readRecording, WORDS, type Deps, type OffscreenAnswer } from './recording';
import { saveSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor, type Call } from './testing';

const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=x';

function world(opts: { api?: (c: Call) => Response | undefined; offscreen?: (m: { type: string }) => OffscreenAnswer; streamId?: () => Promise<string> } = {}) {
  const storage = fakeStorage();
  let t = 1_000_000;
  const net = fakeFetch((c) => {
    const custom = opts.api?.(c);
    if (custom) return custom;
    const path = new URL(c.url).pathname;
    if (path === '/v1/uploads') return json(200, { uploadId: 'up-1', sessionUri: SESSION, storagePath: 'recordings/workspace_alice/note-1.webm', chunkSize: 8388608, expiresAt: '2026-10-07T00:00:00Z' });
    if (path === '/v1/uploads/up-1/complete') return json(200, { uploadId: 'up-1', storagePath: 'recordings/workspace_alice/note-1.webm', complete: true });
    if (path === '/v1/notes') return json(200, { noteId: 'note-1', workspaceId: 'workspace_alice', storagePath: 'recordings/workspace_alice/note-1.webm', created: true });
    if (path === '/v1/process') return json(200, { success: true, noteId: 'note-1', status: 'queued' });
    return json(500, {});
  });
  const sent: Array<{ type: string }> = [];
  const log: string[] = [];
  const local = fakeStorage();
  const deps: Deps = {
    storage, local, fetch: net.fetch, now: () => t,
    streamIdFor: opts.streamId ?? (async (tabId) => `stream-for-${tabId}`),
    async toOffscreen(m) {
      sent.push(m);
      return opts.offscreen?.(m) ?? (m.type === 'start' ? { ok: true, micIncluded: true } : { ok: true, durationSec: 1805, micIncluded: true });
    },
    async closeOffscreen() { log.push('close'); },
    async setBadge(text) { log.push(`badge:${text}`); },
    newNoteId: () => 'note-1',
  };
  return { deps, storage, local, calls: net.calls, sent, log, advance: (ms: number) => { t += ms; } };
}
const signIn = (w: ReturnType<typeof world>) => saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

describe('starting a recording', () => {
  it('gets the tab\'s stream, an upload session of no length for a new note, and starts the offscreen recorder', async () => {
    const w = world();
    await signIn(w);
    expect(await startRecording(w.deps, { tabId: 7, title: 'Call, 30 Sep' })).toEqual({ ok: true });
    expect(paths(w.calls)).toEqual(['POST /v1/uploads']);
    expect(JSON.parse(w.calls[0]!.body!)).toEqual({ noteId: 'note-1', workspaceId: 'workspace_alice', fileName: 'recording.webm', contentType: 'audio/webm' });
    expect(w.calls[0]!.headers.Authorization).toBe(`Bearer ${idTokenFor('alice')}`);
    expect(w.sent).toEqual([{ type: 'start', streamId: 'stream-for-7', sessionUri: SESSION, chunkSize: 8388608 }]);
    expect(await readRecording(w.deps)).toMatchObject({ phase: 'recording', noteId: 'note-1', uploadId: 'up-1', title: 'Call, 30 Sep', micIncluded: true });
    expect(w.log).toEqual(['badge:REC']);
    // What recovery needs if the browser closes mid-way, on disk: the upload, never the sign-in.
    expect(w.local.data.get('unfinished')).toEqual({
      uploadId: 'up-1', sessionUri: SESSION, noteId: 'note-1', workspaceId: 'workspace_alice',
      storagePath: 'recordings/workspace_alice/note-1.webm', title: 'Call, 30 Sep', startedAt: 1_000_000,
    });
    expect([...w.local.data.keys()]).toEqual(['unfinished']);
  });

  it('signed out: nothing is captured or asked', async () => {
    const w = world();
    expect(await startRecording(w.deps, { tabId: 7, title: 't' })).toEqual({ ok: false, error: 'signed_out' });
    expect(w.calls).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('one at a time', async () => {
    const w = world();
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    expect(await startRecording(w.deps, { tabId: 8, title: 't' })).toEqual({ ok: false, error: 'busy' });
    expect(w.sent).toHaveLength(1);
  });

  it('Chrome refusing the tab: no upload session, no recorder', async () => {
    const w = world({ streamId: async () => { throw new Error('Extension has not been invoked for the current page'); } });
    await signIn(w);
    expect(await startRecording(w.deps, { tabId: 7, title: 't' })).toEqual({ ok: false, error: 'capture_failed' });
    expect(w.calls).toHaveLength(0);
    expect(await readRecording(w.deps)).toBeNull();
  });

  it('the api refusing the upload, or this build being too old, starts nothing', async () => {
    for (const [status, error] of [[426, 'please_update'], [401, 'upload_refused']] as const) {
      const w = world({ api: () => json(status, {}) });
      await signIn(w);
      expect(await startRecording(w.deps, { tabId: 7, title: 't' })).toEqual({ ok: false, error });
      expect(w.sent).toHaveLength(0);
    }
  });

  it('the recorder failing to start closes it, and nothing is recording', async () => {
    const w = world({ offscreen: () => ({ ok: false, error: 'capture_failed' }) });
    await signIn(w);
    expect(await startRecording(w.deps, { tabId: 7, title: 't' })).toEqual({ ok: false, error: 'capture_failed' });
    expect(w.log).toEqual(['close']);
    expect(await readRecording(w.deps)).toBeNull();
  });
});

describe('stopping', () => {
  it('finishes the upload, then completes it, makes the note and kicks it off, as the web does', async () => {
    const w = world();
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 'Call, 30 Sep' });
    w.calls.length = 0;
    expect(await stopRecording(w.deps)).toMatchObject({ phase: 'saved', noteId: 'note-1' });
    expect(w.sent.at(-1)).toEqual({ type: 'stop' });
    expect(paths(w.calls)).toEqual(['POST /v1/uploads/up-1/complete', 'POST /v1/notes', 'POST /v1/process']);
    expect(JSON.parse(w.calls[1]!.body!)).toEqual({ uploadId: 'up-1', title: 'Call, 30 Sep', type: 'recording', mimeType: 'audio/webm', durationSec: 1805 });
    expect(JSON.parse(w.calls[2]!.body!)).toEqual({ noteId: 'note-1', workspaceId: 'workspace_alice', type: 'recording', storagePath: 'recordings/workspace_alice/note-1.webm', durationSec: 1805 });
    expect(w.log).toEqual(['badge:REC', 'close', 'badge:']);
    expect(w.local.data.has('unfinished')).toBe(false);
  });

  it('asked twice (Stop, and the tab closing), saves once', async () => {
    const w = world();
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    await stopRecording(w.deps);
    const n = w.calls.length;
    expect(await stopRecording(w.deps)).toMatchObject({ phase: 'saved' });
    expect(w.calls).toHaveLength(n);
  });

  it('out of minutes: the recording is kept, and the popup says what to do', async () => {
    const w = world({ api: (c) => (c.url.endsWith('/v1/process') ? json(402, { error: 'quota_exceeded' }) : undefined) });
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    expect(await stopRecording(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.no_minutes });
    expect(w.log.at(-2)).toBe('badge:');
  });

  it('the note refused, or the kickoff failing, ends it as failed, and a refused note is never kicked off', async () => {
    const refused = world({ api: (c) => (c.url.endsWith('/v1/notes') ? json(409, { error: 'Upload is not complete yet.' }) : undefined) });
    await signIn(refused);
    await startRecording(refused.deps, { tabId: 7, title: 't' });
    expect(await stopRecording(refused.deps)).toMatchObject({ phase: 'failed', error: WORDS.save_failed });
    expect(paths(refused.calls)).not.toContain('POST /v1/process');

    const down = world({ api: (c) => (c.url.endsWith('/v1/process') ? json(503, {}) : undefined) });
    await signIn(down);
    await startRecording(down.deps, { tabId: 7, title: 't' });
    expect(await stopRecording(down.deps)).toMatchObject({ phase: 'failed', error: WORDS.save_failed });
  });

  it('the upload failing ends it as failed, with words, and never makes a note', async () => {
    const w = world({ offscreen: (m) => (m.type === 'start' ? { ok: true, micIncluded: false } : { ok: false, error: 'upload_failed' }) });
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    w.calls.length = 0;
    expect(await stopRecording(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.upload_failed });
    expect(w.calls).toHaveLength(0);
    expect(w.local.data.has('unfinished')).toBe(false);
  });

  it('the network failing while saving ends it as failed, not stuck saving', async () => {
    const w = world({ api: (c) => { if (c.url.endsWith('/complete')) throw new TypeError('Failed to fetch'); return undefined; } });
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    expect(await stopRecording(w.deps)).toMatchObject({ phase: 'failed', error: WORDS.save_failed });
    expect(await readRecording(w.deps)).toMatchObject({ phase: 'failed' });
  });

  it('Done forgets a saved or failed recording, never a running one', async () => {
    const w = world();
    await signIn(w);
    await startRecording(w.deps, { tabId: 7, title: 't' });
    await dismissRecording(w.deps);
    expect(await readRecording(w.deps)).toMatchObject({ phase: 'recording' });
    await stopRecording(w.deps);
    await dismissRecording(w.deps);
    expect(await readRecording(w.deps)).toBeNull();
  });
});
