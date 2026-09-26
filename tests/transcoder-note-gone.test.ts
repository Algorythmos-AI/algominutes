import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// A note deleted while the transcoder works on it (POST /v1/notes/delete) must
// stay deleted. The task is acknowledged: no phantom Firestore doc, no error
// mirror, no retry, no dead letter, no "note failed" push.
const require = createRequire(import.meta.url);
const handler = require('../services/transcoder/src/handler.js');
const mirror = require('../services/transcoder/src/firestore-mirror.js');
const { NoteGoneError, isNoteGone } = require('../services/transcoder/src/note-gone.js');

const notFound = () => Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 });

function fakeFs({ missing = false } = {}) {
  const updates: Array<{ path: string; data: any }> = [];
  return {
    updates,
    doc: (path: string) => ({
      update: async (data: any) => {
        if (missing) throw notFound();
        updates.push({ path, data });
      },
      set: async () => { throw new Error('set() would re-create a deleted note'); },
    }),
  };
}

describe('firestore-mirror', () => {
  it('updates (never sets) the doc; a missing doc is NoteGoneError', async () => {
    const fs = fakeFs();
    await mirror.mirrorStatus({ workspaceId: 'w', noteId: 'n', status: 'chunking' }, fs);
    expect(fs.updates[0]).toMatchObject({ path: 'workspaces/w/notes/n', data: { status: 'chunking' } });
    await expect(mirror.mirrorProgress({ workspaceId: 'w', noteId: 'n', done: 1, total: 2 }, fakeFs({ missing: true }))).rejects.toBeInstanceOf(NoteGoneError);
  });

  it('mirrorReady writes the summary by field path, so a Firestore-only summary.keyPoints survives', async () => {
    const fs = fakeFs();
    await mirror.mirrorReady({ workspaceId: 'w', noteId: 'n', summary: { gist: 'g', actionItems: ['a'] }, transcriptPreview: [] }, fs);
    expect(fs.updates[0].data).toMatchObject({ status: 'ready', 'summary.gist': 'g', 'summary.actionItems': ['a'] });
    expect(fs.updates[0].data.summary).toBeUndefined();
  });

  it('other Firestore errors still propagate as themselves', async () => {
    const fs = { doc: () => ({ update: async () => { throw new Error('UNAVAILABLE'); } }) };
    await expect(mirror.mirrorStatus({ workspaceId: 'w', noteId: 'n', status: 'x' }, fs)).rejects.toThrow('UNAVAILABLE');
  });
});

describe('isNoteGone', () => {
  it('recognises the three signals, and nothing else', () => {
    expect(isNoteGone(new NoteGoneError('x'))).toBe(true);
    expect(isNoteGone(Object.assign(new Error(), { code: 'NOTE_NOT_FOUND' }))).toBe(true);
    expect(isNoteGone(Object.assign(new Error(), { code: '23503' }))).toBe(true); // FK violation
    expect(isNoteGone(new Error('boom'))).toBe(false);
    expect(isNoteGone(Object.assign(new Error(), { code: '23505' }))).toBe(false);
    expect(isNoteGone(null)).toBe(false);
  });
});

describe('transcoder kickoff for a deleted note', () => {
  // `exists`: what each successive noteExists call answers (the kickoff's
  // pre-check, then any re-check after a missing Firestore doc).
  // `upsertErr` fails the status write after the download (the default), or the
  // kickoff's first one with `upsertErrOn: 'chunking'`. `order` records Postgres
  // status writes and mirror writes together.
  function deps({
    exists = [true] as boolean[], upsertErr = null as Error | null, upsertErrOn = 'later' as 'later' | 'chunking',
    mirrorStatusErr = null as Error | null,
  } = {}) {
    const calls: string[] = [];
    const order: string[] = [];
    const warns: Array<{ o: any; m: string }> = [];
    const errors: Array<{ o: any; m: string }> = [];
    const answers = [...exists];
    const client = { release: () => {}, query: async () => ({ rows: [], rowCount: 0 }) };
    return {
      calls,
      order,
      warns,
      errors,
      deps: {
        log: { info: () => {}, error: (o: any, m: string) => void errors.push({ o, m }), warn: (o: any, m: string) => void warns.push({ o, m }) },
        db: {
          pool: () => ({ connect: async () => client }),
          // The kickoff's pre-check reads the status; a later re-check asks noteExists.
          noteStatus: async () => ((answers.length > 1 ? answers.shift() : answers[0]) ? 'queued' : null),
          noteExists: async () => (answers.length > 1 ? answers.shift() : answers[0]),
          upsertNoteStatus: async (_c: unknown, { status }: { status: string }) => {
            order.push(`pg:${status}`);
            if (upsertErr && (upsertErrOn === 'chunking') === (status === 'chunking')) throw upsertErr;
          },
        },
        mirror: {
          mirrorStatus: async ({ status }: { status: string }) => {
            calls.push('mirrorStatus');
            order.push(`mirror:${status}`);
            if (mirrorStatusErr) throw mirrorStatusErr;
          },
          mirrorError: async () => { calls.push('mirrorError'); },
          mirrorProgress: async () => { calls.push('mirrorProgress'); },
        },
        ffmpeg: { ensureTempDir: () => '/tmp/x', probeDuration: async () => 30, cleanupTempDir: () => {} },
        storage: { downloadToLocal: async () => {} },
        fastPath: { run: async () => { calls.push('fastPath'); } },
        tasks: { enqueue: async () => { calls.push('enqueue'); } },
        env: {},
        stt: {},
        youtube: {},
        traceId: 't',
      },
    };
  }
  const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'w1', type: 'recording', storagePath: 'recordings/w1/n1.m4a' };

  it('checks Postgres first: a note that is gone is acknowledged before any write', async () => {
    const d = deps({ exists: [false] });
    await expect(handler.handle(kickoff, d.deps)).resolves.toBeUndefined();
    expect(d.calls).toEqual([]); // no phantom 'chunking' doc, nothing enqueued
    expect(d.warns).toContainEqual(expect.objectContaining({ m: 'transcoder_note_gone' }));
  });

  it("Postgres holds 'chunking' before the mirror shows it", async () => {
    const d = deps();
    await handler.handle(kickoff, d.deps);
    expect(d.order.slice(0, 2)).toEqual(['pg:chunking', 'mirror:chunking']);
  });

  it("deleted between the check and the first status write: acknowledged, and nothing mirrored", async () => {
    const d = deps({ upsertErr: Object.assign(new Error('note_missing_in_postgres:n1'), { code: 'NOTE_NOT_FOUND' }), upsertErrOn: 'chunking' });
    await expect(handler.handle(kickoff, d.deps)).resolves.toBeUndefined();
    expect(d.calls).toEqual([]);
  });

  it('deleted after the check (NOTE_NOT_FOUND on the status write): acknowledged, and no error mirror', async () => {
    const d = deps({ upsertErr: Object.assign(new Error('note_missing_in_postgres:n1'), { code: 'NOTE_NOT_FOUND' }) });
    await expect(handler.handle(kickoff, d.deps)).resolves.toBeUndefined();
    expect(d.calls).toEqual(['mirrorStatus']);
    expect(d.calls).not.toContain('mirrorError');
  });

  it('the Firestore doc gone AND Postgres agrees (deleted mid-run): acknowledged', async () => {
    const d = deps({ exists: [true, false], mirrorStatusErr: new NoteGoneError('firestore') });
    await expect(handler.handle(kickoff, d.deps)).resolves.toBeUndefined();
    expect(d.warns).toContainEqual(expect.objectContaining({ m: 'transcoder_note_gone' }));
  });

  // Firestore also answers NOT_FOUND for a wrong project or database, or a
  // half-failed account deletion. A note still live in Postgres must not be
  // silently dropped: fail, so the task retries and dead-letters visibly.
  it('the Firestore doc missing for a note still live in Postgres: fails loudly, not acknowledged', async () => {
    const d = deps({ exists: [true, true], mirrorStatusErr: new NoteGoneError('firestore') });
    await expect(handler.handle(kickoff, d.deps)).rejects.toThrow('mirror_doc_missing_for_live_note');
    expect(d.errors).toContainEqual(expect.objectContaining({ m: 'transcoder_mirror_doc_missing' }));
  });

  it("any other failure throws so the task retries, and mirrors no failure Postgres doesn't have", async () => {
    const d = deps({ upsertErr: new Error('connection reset') });
    await expect(handler.handle(kickoff, d.deps)).rejects.toThrow('connection reset');
    expect(d.calls).not.toContain('mirrorError');
  });
});

// A permanent YouTube failure must fail the note in Postgres too. A
// Firestore-only error mirror left Postgres at 'queued', which the idempotent
// kickoff reads as "in flight", so a retry was refused for 3 h.
describe('transcoder kickoff: a permanent YouTube failure', () => {
  it('marks the note failed in Postgres (then the mirror), runs the terminal hooks, and acknowledges', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      release: () => {},
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        // markNoteFailed's UPDATE returns the status it replaced.
        return /SELECT prev_status, error_message[\s\S]*FROM upd/.test(sql) ? { rows: [{ prev_status: 'queued' }], rowCount: 1 } : { rows: [], rowCount: 1 };
      },
    };
    const mirrored: any[] = [];
    const hooks: string[] = [];
    const deps = {
      log: { info: () => {}, error: () => {}, warn: () => {} },
      db: { pool: () => ({ connect: async () => client }), noteExists: async () => true, noteStatus: async () => 'queued', upsertNoteStatus: async () => {} },
      mirror: {
        mirrorStatus: async () => {},
        mirrorError: async () => { throw new Error('the Firestore-only error mirror must not be used here'); },
        db: () => ({ doc: (path: string) => ({ update: async (data: any) => void mirrored.push({ path, data }) }) }),
      },
      youtube: {
        fetchAudio: async () => { throw Object.assign(new Error('private video'), { isPermanent: true, publicMessage: 'This video is private.' }); },
      },
      ffmpeg: { ensureTempDir: () => '/tmp/x', cleanupTempDir: () => {} },
      terminalHooks: { onTranscodeTerminalFailure: async () => void hooks.push('terminal') },
      env: {}, stt: {}, storage: {}, fastPath: {}, tasks: {}, traceId: 't',
    };
    await expect(handler.handle({ kind: 'kickoff', noteId: 'n1', workspaceId: 'w1', type: 'youtube', sourceUrl: 'https://youtu.be/x' }, deps))
      .resolves.toBeUndefined();
    const failed = queries.find((q) => /UPDATE notes n SET status = 'error'/.test(q.sql));
    // The recording's traceId goes into the statement, for the failure's notice.
    expect(failed?.params).toEqual(['n1', 'This video is private.', 'w1', null, null, 't']);
    expect(mirrored).toEqual([{ path: 'workspaces/w1/notes/n1', data: expect.objectContaining({ status: 'error', errorMessage: 'This video is private.' }) }]);
    expect(hooks).toEqual(['terminal']);
  });
});

// The last chunk done: Postgres holds 'summarizing' before the mirror shows it
// and the summarizer is enqueued (both engines share this tail).
describe('transcoder: the completion gate', () => {
  it("writes 'summarizing' to Postgres, then mirrors it, then enqueues the summarizer", async () => {
    const order: string[] = [];
    const client = { release: () => {}, query: async () => ({ rows: [{ done: 2, total: 2 }], rowCount: 1 }) };
    const deps = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      db: {
        pool: () => ({ connect: async () => client }),
        insertTranscriptLines: async () => {},
        // The gate's transaction (completeChunkGate) claims and writes 'summarizing'.
        completeChunkGate: async () => { order.push('pg:summarizing'); return { allDone: true, summarizerClaimed: true, embedderClaimed: false }; },
        chunkProgress: async () => ({ done: 2, total: 2 }),
      },
      mirror: {
        mirrorProgress: async () => {},
        mirrorStatus: async ({ status }: { status: string }) => void order.push(`mirror:${status}`),
      },
      tasks: { enqueueSummarizer: async () => void order.push('enqueue:summarizer'), enqueueEmbedder: async () => {} },
      storage: { deletePrefix: async () => {} },
    };
    await handler.completeChunkAndAdvance({ noteId: 'n1', workspaceId: 'w1', chunkId: 7, lines: [], deps });
    expect(order).toEqual(['pg:summarizing', 'mirror:summarizing', 'enqueue:summarizer']);
  });

  it("a replayed completion (the summarizer already claimed) writes no status and enqueues nothing", async () => {
    const order: string[] = [];
    const client = { release: () => {}, query: async () => ({ rows: [{ done: 2, total: 2 }], rowCount: 1 }) };
    const deps = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      db: {
        pool: () => ({ connect: async () => client }),
        insertTranscriptLines: async () => {},
        completeChunkGate: async () => ({ allDone: true, summarizerClaimed: false, embedderClaimed: false }),
        chunkProgress: async () => ({ done: 2, total: 2 }),
      },
      mirror: { mirrorProgress: async () => {}, mirrorStatus: async () => void order.push('mirror') },
      tasks: { enqueueSummarizer: async () => void order.push('enqueue'), enqueueEmbedder: async () => {} },
      storage: { deletePrefix: async () => {} },
    };
    await handler.completeChunkAndAdvance({ noteId: 'n1', workspaceId: 'w1', chunkId: 7, lines: [], deps });
    expect(order).toEqual([]);
  });
});
