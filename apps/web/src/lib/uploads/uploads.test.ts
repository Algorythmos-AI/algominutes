import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { nextOffset, uploadResumable, UploadError } from './resumable';
import { failureMessage, kickoffFailure, noteError, quotaMessage } from './kickoff';
import { importAudio, importProblem, titleFrom, MAX_IMPORT_BYTES } from './importAudio';

const KB = 1024;

/** A GCS resumable session in memory: it keeps the bytes it's sent and answers as GCS does. */
function gcs(opts: { failOnce?: Set<number>; expire?: boolean; expireOnce?: boolean; held?: number } = {}) {
  let held = opts.held ?? 0;
  let total = -1;
  const puts: string[] = [];
  let n = 0;
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    n += 1;
    const range = (init?.headers as Record<string, string>)['Content-Range'];
    puts.push(range);
    if (opts.expire) return new Response(null, { status: 410 });
    if (opts.expireOnce) {
      opts.expireOnce = false;
      held = 0;
      return new Response(null, { status: 410 });
    }
    if (opts.failOnce?.has(n)) {
      opts.failOnce.delete(n);
      throw new TypeError('network down');
    }
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
    if (m) {
      total = Number(m[3]);
      if (Number(m[1]) !== held) return new Response(null, { status: 503 });
      held = Number(m[2]) + 1;
    }
    if (held >= total && total > 0) return new Response(null, { status: 200 });
    return new Response(null, { status: 308, headers: held ? { Range: `bytes=0-${held - 1}` } : {} });
  }) as typeof fetch;
  return { fetchImpl, puts, held: () => held };
}

const file = (bytes: number, name = 'standup.m4a', type = 'audio/mp4') => new File([new Uint8Array(bytes)], name, { type });
const noSleep = async () => {};

describe('uploadResumable', () => {
  it('sends 256 KiB-aligned chunks with Content-Range, and reports progress', async () => {
    const g = gcs();
    const progress: number[] = [];
    await uploadResumable({ file: file(700 * KB), sessionUri: 'https://s', chunkSize: 300 * KB, receivedBytes: async () => g.held(), fetchImpl: g.fetchImpl, onProgress: (s) => progress.push(s), sleep: noSleep });
    expect(g.puts).toEqual([`bytes 0-${256 * KB - 1}/${700 * KB}`, `bytes ${256 * KB}-${512 * KB - 1}/${700 * KB}`, `bytes ${512 * KB}-${700 * KB - 1}/${700 * KB}`]);
    expect(progress.at(-1)).toBe(700 * KB);
  });

  it('starts from startAt when the session already holds bytes (a resumed upload)', async () => {
    const g = gcs({ held: 256 * KB });
    await uploadResumable({ file: file(700 * KB), sessionUri: 'https://s', chunkSize: 256 * KB, startAt: 256 * KB, receivedBytes: async () => g.held(), fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(g.puts[0]).toBe(`bytes ${256 * KB}-${512 * KB - 1}/${700 * KB}`);
    expect(g.held()).toBe(700 * KB);
  });

  it('after a dropped chunk, resumes from what the api says GCS holds', async () => {
    const g = gcs({ failOnce: new Set([2]) });
    const status = vi.fn(async () => g.held());
    await uploadResumable({ file: file(600 * KB), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: status, fetchImpl: g.fetchImpl, sleep: noSleep });
    expect(status).toHaveBeenCalledTimes(1);
    expect(g.held()).toBe(600 * KB);
    expect(g.puts[2]).toBe(g.puts[1]); // the dropped chunk was sent again, from the server's offset
  });

  it('gives up after repeated failures, and an expired session says so', async () => {
    const down = (async () => { throw new TypeError('offline'); }) as typeof fetch;
    await expect(uploadResumable({ file: file(10), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: async () => 0, fetchImpl: down, sleep: noSleep, maxRetries: 2 })).rejects.toMatchObject({ kind: 'failed' });
    await expect(uploadResumable({ file: file(10), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: async () => 0, fetchImpl: gcs({ expire: true }).fetchImpl, sleep: noSleep })).rejects.toMatchObject({ kind: 'expired' });
  });

  it("a session that never advances can't loop for ever", async () => {
    const stuck = (async () => new Response(null, { status: 308 })) as typeof fetch;
    await expect(uploadResumable({ file: file(10), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: async () => 0, fetchImpl: stuck, sleep: noSleep, maxRetries: 3 })).rejects.toBeInstanceOf(UploadError);
  });

  it('stops when cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(uploadResumable({ file: file(10), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: async () => 0, fetchImpl: gcs().fetchImpl, signal: stop.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it("a 308 with no readable Range after bytes were sent asks the api, rather than restarting at 0", async () => {
    let held = 0;
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec((init?.headers as Record<string, string>)['Content-Range'])!;
      held = Number(m[2]) + 1;
      if (held >= Number(m[3])) return new Response(null, { status: 200 });
      return new Response(null, { status: 308 }); // Range hidden from the browser
    }) as typeof fetch;
    const status = vi.fn(async () => held);
    await uploadResumable({ file: file(600 * KB), sessionUri: 'https://s', chunkSize: 256 * KB, receivedBytes: status, fetchImpl, sleep: noSleep });
    expect(status).toHaveBeenCalledTimes(2); // after the first two chunks; the third completes, and nothing restarted
    expect(held).toBe(600 * KB);
  });

  it('reads the Range header', () => {
    expect(nextOffset('bytes=0-262143')).toBe(262144);
    expect(nextOffset(null)).toBe(0);
  });
});

describe('kickoff failures, as iOS KickoffFailure', () => {
  const e = (kind: ConstructorParameters<typeof ApiError>[0], extra = {}) => new ApiError(kind, extra);
  it('quota, update, refused (the server marked the note) and failed', () => {
    expect(kickoffFailure(e('quota_exceeded'), 'x').kind).toBe('quota');
    expect(kickoffFailure(e('update_required'), 'x').kind).toBe('update_required');
    const refused = kickoffFailure(e('too_large', { code: 'That file is too large. The current limit is 500 MB.' }), 'x');
    expect(refused).toEqual({ kind: 'refused', message: 'That file is too large. The current limit is 500 MB.' });
    expect(noteError(refused)).toBeNull();
    expect(failureMessage(kickoffFailure(e('rate_limited', { code: 'rate_limited' }), 'x'))).not.toBe('rate_limited');
    expect(kickoffFailure(e('not_found'), 'x')).toEqual({ kind: 'failed', message: "We couldn't find this recording's audio. Please try again." });
    expect(noteError(kickoffFailure(e('server'), 'fallback'))).toBe('fallback');
  });

  it('the quota message says when the minutes come back, with no paywall to send people to', () => {
    expect(quotaMessage({ state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 60, remainingMinutes: 0, overQuota: true })).toBe("You've used this month's 60 included minutes. They reset on 1 October, or a new invite code adds more (Settings).");
    expect(quotaMessage(null)).toMatch(/come with an invite code\. Enter yours in Settings/);
  });
});

describe('importAudio', () => {
  const session = { uploadId: 'u1', sessionUri: 'https://storage.googleapis.com/s', storagePath: 'recordings/workspace_u1/web1.m4a', chunkSize: 8 * 1024 * KB, expiresAt: '2026-10-03T00:00:00Z' };
  const deps = (over: Record<string, unknown> = {}) => {
    const g = gcs();
    const api = {
      entitlement: vi.fn(async () => ({ state: 'active' as const, plan: 'free' as const, billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 1, remainingMinutes: 59, overQuota: false })),
      deleteNote: vi.fn(async () => ({ ok: true as const, noteId: 'web1', deleted: true })),
      createUpload: vi.fn(async () => session),
      uploadStatus: vi.fn(async () => ({ uploadId: 'u1', receivedBytes: g.held(), complete: false })),
      completeUpload: vi.fn(async () => ({ uploadId: 'u1', storagePath: session.storagePath, complete: true as const })),
      process: vi.fn(async () => ({ success: true as const, noteId: 'web1', jobId: 'j', status: 'queued' as const })),
    };
    return {
      api, g,
      createNoteDoc: vi.fn(async () => {}),
      markNoteFailed: vi.fn(async () => {}),
      d: { api, uid: 'u1', probeDuration: async () => 125, newNoteId: () => 'web1', fetchImpl: g.fetchImpl, sleep: noSleep, createNoteDoc: vi.fn(async () => {}), markNoteFailed: vi.fn(async () => {}), ...over },
    };
  };

  it('mints a session, writes the note doc, uploads, completes, then kicks off, as iOS does', async () => {
    const { d, api } = deps();
    const r = await importAudio(file(10 * KB), d);
    expect(r).toEqual({ ok: true, noteId: 'web1' });
    expect(api.createUpload).toHaveBeenCalledWith({ noteId: 'web1', workspaceId: 'workspace_u1', fileName: 'standup.m4a', contentType: 'audio/mp4', totalBytes: 10 * KB });
    expect(d.createNoteDoc).toHaveBeenCalledWith({ noteId: 'web1', uid: 'u1', title: 'standup', type: 'import_audio', mimeType: 'audio/mp4', storagePath: session.storagePath, duration: 125 });
    expect(api.completeUpload).toHaveBeenCalledWith('u1');
    expect(api.process).toHaveBeenCalledWith({ noteId: 'web1', workspaceId: 'workspace_u1', type: 'import_audio', storagePath: session.storagePath, mimeType: 'audio/mp4', durationSec: 125 });
    expect(d.markNoteFailed).not.toHaveBeenCalled();
  });

  it('checks the file before anything is uploaded or written', async () => {
    const { d, api } = deps();
    expect(await importAudio(file(0), d)).toMatchObject({ ok: false, message: 'That file is empty.' });
    expect(importProblem(new File(['x'], 'notes.pdf', { type: 'application/pdf' }))).toMatch(/isn’t supported/);
    expect(importProblem({ size: MAX_IMPORT_BYTES + 1, name: 'a.mp3', type: 'audio/mpeg' } as File)).toMatch(/too large/);
    expect(api.createUpload).not.toHaveBeenCalled();
  });

  it('a dead upload marks the note failed; a refused kickoff leaves the server\'s mark alone', async () => {
    const offline = deps({ fetchImpl: (async () => { throw new TypeError('offline'); }) as typeof fetch });
    const r = await importAudio(file(10), offline.d);
    expect(r).toMatchObject({ ok: false, noteId: 'web1' });
    expect(offline.d.markNoteFailed).toHaveBeenCalledWith('web1', expect.stringMatching(/didn't finish/));
    expect(offline.api.process).not.toHaveBeenCalled();

    const refused = deps();
    refused.api.process.mockRejectedValueOnce(new ApiError('too_large', { code: 'That file is too large. The current limit is 500 MB.' }));
    expect(await importAudio(file(10), refused.d)).toMatchObject({ ok: false, message: 'That file is too large. The current limit is 500 MB.' });
    expect(refused.d.markNoteFailed).not.toHaveBeenCalled();

    const quota = deps();
    quota.api.process.mockRejectedValueOnce(new ApiError('quota_exceeded', { entitlement: null }));
    await importAudio(file(10), quota.d);
    expect(quota.d.markNoteFailed).toHaveBeenCalledWith('web1', expect.stringMatching(/invite code/));
  });

  it("a session that couldn't be minted, or a note doc that couldn't be written, uploads nothing", async () => {
    const noSession = deps();
    noSession.api.createUpload.mockRejectedValueOnce(new ApiError('server'));
    expect(await importAudio(file(10), noSession.d)).toMatchObject({ ok: false, noteId: null });
    const noDoc = deps({ createNoteDoc: vi.fn(async () => { throw new Error('permission-denied'); }) });
    expect(await importAudio(file(10), noDoc.d)).toMatchObject({ ok: false, noteId: null });
    expect(noDoc.g.puts).toEqual([]);
  });

  it('only formats the pipeline can send to Gemini', () => {
    expect(importProblem(file(10, 'call.m4a', ''))).toBeNull();
    expect(importProblem(file(10, 'call', 'audio/mpeg'))).toBeNull();
    for (const [name, type] of [['clip.mov', 'video/quicktime'], ['memo.amr', 'audio/amr'], ['v.3gp', 'video/3gpp'], ['a.caf', 'audio/x-caf']]) {
      expect(importProblem(file(10, name, type)), name).toMatch(/isn’t supported/);
    }
  });

  it('spent minutes are refused before anything is uploaded', async () => {
    const { d, api } = deps();
    api.entitlement.mockResolvedValueOnce({ state: 'active', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 60, remainingMinutes: 0, overQuota: true });
    expect(await importAudio(file(10), d)).toMatchObject({ ok: false, noteId: null, message: expect.stringMatching(/used this month's 60 included minutes/) });
    expect(api.createUpload).not.toHaveBeenCalled();
  });

  it('a cancel mid-upload deletes the note instead of leaving a failure; a cancel before it mints nothing', async () => {
    const stop = new AbortController();
    const slow = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      stop.abort();
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Response(null, { status: 308 });
    }) as typeof fetch;
    const mid = deps({ fetchImpl: slow, signal: stop.signal });
    expect(await importAudio(file(10), mid.d)).toMatchObject({ ok: false, message: 'The upload was cancelled.' });
    expect(mid.api.deleteNote).toHaveBeenCalledWith({ noteId: 'web1', workspaceId: 'workspace_u1' });
    expect(mid.d.markNoteFailed).not.toHaveBeenCalled();
    expect(mid.api.process).not.toHaveBeenCalled();

    const early = new AbortController();
    early.abort();
    const before = deps({ signal: early.signal });
    await importAudio(file(10), before.d);
    expect(before.api.createUpload).not.toHaveBeenCalled();
    expect(before.d.createNoteDoc).not.toHaveBeenCalled();
  });

  it('tracks the upload as this browser\'s until the server owns the note', async () => {
    const events: string[] = [];
    const { d } = deps({ track: { start: (id: string) => events.push(`start ${id}`), end: (id: string) => events.push(`end ${id}`) } });
    await importAudio(file(10), d);
    expect(events).toEqual(['start web1', 'end web1']);
  });

  it("a cut-off recording upload's retry puts the audio into the note it left, not a second one", async () => {
    const noted: string[] = [];
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'webOld', newNoteId: () => 'webNew', onNote: (id: string) => noted.push(id) });
    const r = await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d);
    expect(r).toEqual({ ok: true, noteId: 'webOld' });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(api.createUpload).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'webOld' }));
    // Its doc is already there: writing it again would be a second create.
    expect(d.createNoteDoc).not.toHaveBeenCalled();
    expect(api.process).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'webOld', type: 'recording' }));
    expect(noted).toEqual(['webOld']);
  });

  it('a note to reuse that was deleted since (404) gets a new note, and is forgotten', async () => {
    const events: string[] = [];
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'webOld', newNoteId: () => 'webNew', onNote: (id: string) => events.push(`note ${id}`), onNoteDropped: () => events.push('dropped') });
    api.createUpload.mockImplementationOnce(async () => { throw new ApiError('not_found', { status: 404 }); });
    const r = await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d);
    expect(r).toEqual({ ok: true, noteId: 'webNew' });
    expect(api.createUpload.mock.calls.map((c) => (c as unknown as [{ noteId: string }])[0].noteId)).toEqual(['webOld', 'webNew']);
    expect(d.createNoteDoc).toHaveBeenCalledWith(expect.objectContaining({ noteId: 'webNew' }));
    expect(events).toEqual(['dropped', 'note webNew']);
  });

  it('any other refusal of a note to reuse stops there: no new note', async () => {
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'webOld', newNoteId: () => 'webNew' });
    api.createUpload.mockImplementationOnce(async () => { throw new ApiError('bad_request', { status: 403 }); });
    expect(await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d)).toMatchObject({ ok: false, noteId: null });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(d.createNoteDoc).not.toHaveBeenCalled();
  });

  // RELEASE.md rev 11, LM8 (the owner's choice, 2026-10-01): Try again carries on, it doesn't start over.
  it("a recording's failed upload keeps its note, marked failed, with its session remembered for the retry", async () => {
    const events: unknown[] = [];
    const { d, api } = deps({ recording: { title: 'Recording' }, fetchImpl: (async () => { throw new TypeError('offline'); }) as typeof fetch, onNote: (id: string, s: unknown) => events.push([id, s]), onNoteDropped: () => events.push('dropped') });
    expect(await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d)).toMatchObject({ ok: false, noteId: 'web1' });
    expect(events).toEqual([['web1', { uploadId: 'u1', sessionUri: session.sessionUri, chunkSize: session.chunkSize, storagePath: session.storagePath, totalBytes: 10 * KB }]]);
    expect(api.deleteNote).not.toHaveBeenCalled();
    expect(d.markNoteFailed).toHaveBeenCalledWith('web1', expect.any(String));
  });

  it('the retry carries on in the same session, from the bytes Cloud Storage holds: no new session, no new note', async () => {
    const g = gcs({ held: 512 * KB });
    const kept = { uploadId: 'u1', sessionUri: session.sessionUri, chunkSize: 256 * KB, storagePath: session.storagePath, totalBytes: 700 * KB };
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'web1', reuseSession: kept, fetchImpl: g.fetchImpl });
    api.uploadStatus.mockImplementation(async () => ({ uploadId: 'u1', receivedBytes: g.held(), complete: false }));
    const progress: number[] = [];
    expect(await importAudio(file(700 * KB, 'recording.webm', 'audio/webm'), { ...d, onProgress: (f: number) => progress.push(f) })).toEqual({ ok: true, noteId: 'web1' });
    expect(api.createUpload).not.toHaveBeenCalled();
    expect(d.createNoteDoc).not.toHaveBeenCalled();
    // Only the last 188 KiB is sent.
    expect(g.puts).toEqual([`bytes ${512 * KB}-${700 * KB - 1}/${700 * KB}`]);
    expect(progress[0]).toBeCloseTo(512 / 700, 3);
    expect(api.completeUpload).toHaveBeenCalledWith('u1');
  });

  it('a remembered session for a different size of file is not resumed', async () => {
    const kept = { uploadId: 'old', sessionUri: 'https://old', chunkSize: 256 * KB, storagePath: session.storagePath, totalBytes: 999 };
    const { d, api, g } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'web1', reuseSession: kept });
    expect(await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d)).toEqual({ ok: true, noteId: 'web1' });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(g.puts[0]).toMatch(/^bytes 0-/);
  });

  it('a remembered session Cloud Storage has let go of: a new one, from the start, and it is remembered', async () => {
    const g = gcs({ held: 512 * KB, expireOnce: true });
    const kept = { uploadId: 'old', sessionUri: 'https://old', chunkSize: 256 * KB, storagePath: session.storagePath, totalBytes: 700 * KB };
    const remembered: string[] = [];
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'web1', reuseSession: kept, fetchImpl: g.fetchImpl, onNote: (_id: string, s: { uploadId: string }) => remembered.push(s.uploadId) });
    api.uploadStatus.mockImplementation(async () => ({ uploadId: 'old', receivedBytes: g.held(), complete: false }));
    expect(await importAudio(file(700 * KB, 'recording.webm', 'audio/webm'), d)).toEqual({ ok: true, noteId: 'web1' });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
    expect(remembered).toEqual(['old', 'u1']);
    expect(g.puts[1]).toMatch(/^bytes 0-/);
  });

  it('a remembered session the server no longer knows: a new one is minted', async () => {
    const kept = { uploadId: 'gone', sessionUri: 'https://old', chunkSize: 256 * KB, storagePath: session.storagePath, totalBytes: 10 * KB };
    const { d, api } = deps({ recording: { title: 'Recording' }, reuseNoteId: 'web1', reuseSession: kept });
    api.uploadStatus.mockImplementationOnce(async () => { throw new ApiError('not_found', { status: 404, message: 'gone' } as never); });
    expect(await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d)).toEqual({ ok: true, noteId: 'web1' });
    expect(api.createUpload).toHaveBeenCalledTimes(1);
  });

  it("remembering the note is best effort: a failure there doesn't stop the upload", async () => {
    const { d } = deps({ recording: { title: 'Recording' }, onNote: async () => { throw new Error('IndexedDB full'); } });
    expect(await importAudio(file(10 * KB, 'recording.webm', 'audio/webm'), d)).toEqual({ ok: true, noteId: 'web1' });
  });

  it('titles come from the file name', () => {
    expect(titleFrom('Board meeting.m4a')).toBe('Board meeting');
    expect(titleFrom('.m4a')).toBe('Imported recording');
  });
});
