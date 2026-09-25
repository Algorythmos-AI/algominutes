import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A first run can commit a finished note to Postgres and then fail to mirror it
// (the fast path's mirrorReady on a Firestore blip). Its retry finds the note
// finished and used to acknowledge without mirroring, so the doc stayed at
// 'chunking' for good: an endless spinner with no Try again. The replay now
// brings the doc in line with Postgres. Real Postgres; Firestore is a fake.
const require = createRequire(import.meta.url);
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const realMirror = require('../../services/transcoder/src/firestore-mirror.js');

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const docs: Record<string, any> = {};
const fsStub = {
  doc: (path: string) => ({
    update: async (data: any) => {
      const doc = docs[path] || {};
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) { const [a, b] = k.split('.'); doc[a] = { ...(doc[a] || {}), [b]: v }; } else doc[k] = v;
      }
      docs[path] = doc;
    },
  }),
};
const doc = () => docs['workspaces/ws/notes/n1'];

function deps({ fastPathRun }: { fastPathRun?: (a: any) => Promise<void> } = {}) {
  return {
    log, env: {}, traceId: 't-remirror', db: transcoderDb,
    storage: { downloadToLocal: async () => {} },
    ffmpeg: { ensureTempDir: () => '/tmp/remirror-test', cleanupTempDir: noop, probeDuration: async () => 120 },
    stt: {}, tasks: { enqueue: async () => {} }, youtube: {},
    mirror: {
      mirrorStatus: (a: any) => realMirror.mirrorStatus(a, fsStub),
      mirrorFinished: (a: any) => realMirror.mirrorFinished(a, fsStub),
      mirrorProgress: async () => {},
    },
    fastPath: { run: fastPathRun || (async () => { throw new Error('the fast path must not run again'); }) },
    terminalHooks: { onTranscodeTerminalFailure: async () => {} },
  };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', type: 'recording', storagePath: 'recordings/ws/n1.aac' };

beforeEach(async () => {
  await resetDb();
  for (const k of Object.keys(docs)) delete docs[k];
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  docs['workspaces/ws/notes/n1'] = { status: 'queued', summary: { keyPoints: ['kept'] } };
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

describe('a kickoff replayed after its note finished', () => {
  it("the fast path committed Postgres and then couldn't mirror: the retry mirrors the note from Postgres", async () => {
    const actionItems = ['Send the deck', 'Book the room', 'Call Sam', 'Draft the memo'];
    const first = deps({
      fastPathRun: async ({ noteId, workspaceId }: any) => {
        await transcoderDb.persistFastPathResult(transcoderDb.pool(), {
          noteId, workspaceId, model: 'gemini-3.5-flash',
          lines: [{ startMs: 0, text: 'Speaker 1: Hello all.' }, { startMs: 65_000, text: 'Speaker 2: Hi.' }],
          summary: { gist: 'A short sync.', actionItems, keyDecisions: ['Ship Friday'] },
        }, log);
        throw new Error('14 UNAVAILABLE: firestore blip');
      },
    });
    await expect(handler.handle(kickoff, first)).rejects.toThrow(/UNAVAILABLE/);
    expect(doc().status).toBe('chunking');

    await handler.handle(kickoff, deps());
    expect(doc()).toMatchObject({
      status: 'ready',
      summary: { gist: 'A short sync.', actionItems, keyDecisions: ['Ship Friday'], chapters: [], keyPoints: ['kept'] },
      transcript: [
        { speaker: 'Speaker 1', text: 'Hello all.', time: '00:00' },
        { speaker: 'Speaker 2', text: 'Hi.', time: '01:05' },
      ],
      transcriptTruncated: false,
    });
  });

  it("a note Postgres failed: the doc gets Postgres's status and message", async () => {
    await pool.query(`UPDATE notes SET status = 'error', error_message = 'Transcription failed for this recording.' WHERE id = 'n1'`);
    await handler.handle(kickoff, deps());
    expect(doc()).toMatchObject({ status: 'error', errorMessage: 'Transcription failed for this recording.' });
  });

  it("a note still summarizing: nothing to repair, and the doc isn't touched", async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    await handler.handle(kickoff, deps());
    expect(doc()).toEqual({ status: 'queued', summary: { keyPoints: ['kept'] } });
  });
});

describe('finishedNoteMirror', () => {
  it('is null for a note in progress, a deleted note, or another workspace', async () => {
    const read = async (workspaceId = 'ws') => {
      const c = await transcoderDb.pool().connect();
      try { return await transcoderDb.finishedNoteMirror(c, { noteId: 'n1', workspaceId }); } finally { c.release(); }
    };
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    expect(await read()).toBeNull();
    await pool.query(`UPDATE notes SET status = 'error', error_message = 'x' WHERE id = 'n1'`);
    expect(await read('ws-other')).toBeNull();
    expect(await read()).toEqual({ status: 'error', errorMessage: 'x' });
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect(await read()).toBeNull();
  });
});
