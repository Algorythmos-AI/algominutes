import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A failure the handler decides on itself (an unreadable file, a speech job
// that errored, a transcript with no words) is acknowledged: nothing will change
// on a retry. But if Postgres can't take the "failed" write, acknowledging left
// the note in progress in Postgres, with only Firestore (or nothing) saying
// "error". Those paths now throw instead, so Cloud Tasks retries the whole
// decision; the queue's last attempt still ends in the index.js terminal path.
// Real Postgres; a trigger stands in for the outage on the notes write.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const mirrored: any[] = [];
const fsStub = { doc: () => ({ update: async (data: any) => void mirrored.push(data) }) };
for (const [id, exports] of [
  ['firebase-admin/firestore', { getFirestore: () => fsStub }],
  ['firebase-admin/app', { initializeApp: () => {}, getApps: () => [{}] }],
] as const) {
  const p = require.resolve(id);
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as never;
}
const { markNoteFailed } = require('@algominutes/db/note-terminal.cjs');
const transcoder = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const summarizer = require('../../services/summarizer/src/handler.js');

const noop = () => {};
const lines: string[] = [];
const log: any = { info: noop, warn: noop, error: (_o: unknown, m: string) => void lines.push(m), child: () => log };

const breakFailedWrites = () => pool.query(`
  CREATE OR REPLACE FUNCTION test_notes_outage() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.status = 'error' THEN RAISE EXCEPTION 'simulated outage'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER test_notes_outage BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION test_notes_outage();`);
const heal = () => pool.query(`DROP TRIGGER IF EXISTS test_notes_outage ON notes; DROP FUNCTION IF EXISTS test_notes_outage();`);
const note = async () => (await pool.query(`SELECT status, error_message FROM notes WHERE id = 'n1'`)).rows[0];

function transcoderDeps({ probe = async (): Promise<number> => 1500, op = { done: false } as any } = {}) {
  const terminal: any[] = [];
  const d = {
    log, env: {}, traceId: 't-terminal',
    db: transcoderDb,
    storage: { downloadToLocal: async () => {}, uploadFromLocal: async (_l: string, p: string) => `gs://bucket/${p}` },
    ffmpeg: {
      ensureTempDir: () => '/tmp/terminal-retry-test', cleanupTempDir: noop,
      probeDuration: probe, extractChunk: async () => {},
    },
    stt: { startLongRunning: async () => 'op-1', checkOperation: async () => op },
    tasks: { enqueue: async () => {} },
    mirror: {
      mirrorStatus: async () => {}, mirrorProgress: async () => {}, db: () => fsStub,
      mirrorError: async ({ errorMessage }: { errorMessage: string }) => void mirrored.push({ status: 'error', errorMessage }),
    },
    fastPath: { run: async () => { throw new Error('fast path must not run'); } },
    youtube: {},
    terminalHooks: { onTranscodeTerminalFailure: async (a: any) => { terminal.push(a); } },
  };
  return { d, terminal };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', type: 'recording', storagePath: 'recordings/ws/n1.aac' };
const unreadable = async (): Promise<number> => { throw new Error('no duration'); };

beforeEach(async () => {
  await heal();
  await resetDb();
  lines.length = 0;
  mirrored.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
});
afterEach(heal);
afterAll(async () => {
  await transcoderDb.pool().end();
  await summarizer.pool().end();
  await pool.end();
  await repo.getPool().end();
});

describe('markNoteFailed with retryOnPgError', () => {
  it('throws on a Postgres error and leaves Firestore alone; without it, it still mirrors and returns', async () => {
    await breakFailedWrites();
    await expect(markNoteFailed({ pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 't', retryOnPgError: true }))
      .rejects.toThrow(/simulated outage/);
    expect(mirrored).toEqual([]);
    expect(lines).toContain('t_pg_failed');
    expect(lines).not.toContain('note_failed');

    await markNoteFailed({ pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 't' });
    expect(mirrored.map((m) => m.status)).toEqual(['error']);
  });

  it("with onlyIfStatus, a Postgres error mirrors nothing (Postgres couldn't say the note was one to fail)", async () => {
    await breakFailedWrites();
    const r = await markNoteFailed({ pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 't', onlyIfStatus: ['queued'] });
    expect(r).toEqual({ failed: false, marked: false, pgErrored: true, exists: false, refunded: false });
    expect(mirrored).toEqual([]);
  });
});

describe('the transcoder retries a failure it decided on, when Postgres missed it', () => {
  it("an unreadable recording: throws, then the retry marks it failed and runs the terminal hooks once", async () => {
    await breakFailedWrites();
    const first = transcoderDeps({ probe: unreadable });
    await expect(transcoder.handle(kickoff, first.d)).rejects.toThrow(/simulated outage/);
    expect((await note()).status).not.toBe('error');
    expect(mirrored.filter((m) => m.status === 'error')).toEqual([]);
    expect(first.terminal).toEqual([]);

    await heal();
    const retry = transcoderDeps({ probe: unreadable });
    await transcoder.handle(kickoff, retry.d);
    expect((await note()).status).toBe('error');
    expect(mirrored.filter((m) => m.status === 'error')).toHaveLength(1);
    expect(retry.terminal).toHaveLength(1);
  });

  it("a speech job that errored: the chunk isn't marked failed until the note is, so the retry isn't skipped", async () => {
    await transcoder.handle(kickoff, transcoderDeps().d);
    const [c0] = (await pool.query(`SELECT id FROM audio_chunks WHERE note_id = 'n1' ORDER BY idx LIMIT 1`)).rows;
    const pollTask = { kind: 'stt-poll', jobId: 'j', chunkId: c0.id, noteId: 'n1', workspaceId: 'ws', poll: 2 };
    const errored = { done: true, error: { message: 'bad audio' } };

    await breakFailedWrites();
    const first = transcoderDeps({ op: errored });
    await expect(transcoder.handle(pollTask, first.d)).rejects.toThrow(/simulated outage/);
    expect((await pool.query(`SELECT status FROM audio_chunks WHERE id = $1`, [c0.id])).rows[0].status).not.toBe('error');
    expect(first.terminal).toEqual([]);

    await heal();
    const retry = transcoderDeps({ op: errored });
    await transcoder.handle(pollTask, retry.d);
    expect((await note()).status).toBe('error');
    expect((await pool.query(`SELECT status FROM audio_chunks WHERE id = $1`, [c0.id])).rows[0].status).toBe('error');
    expect(retry.terminal).toHaveLength(1);
  });
  it('a poll chain that ran out: the same, the chunk is marked failed only after the note', async () => {
    await transcoder.handle(kickoff, transcoderDeps().d);
    const [c0] = (await pool.query(`SELECT id FROM audio_chunks WHERE note_id = 'n1' ORDER BY idx LIMIT 1`)).rows;
    const lastPoll = { kind: 'stt-poll', jobId: 'j', chunkId: c0.id, noteId: 'n1', workspaceId: 'ws', poll: 120 };

    await breakFailedWrites();
    await expect(transcoder.handle(lastPoll, transcoderDeps().d)).rejects.toThrow(/simulated outage/);
    expect((await pool.query(`SELECT status FROM audio_chunks WHERE id = $1`, [c0.id])).rows[0].status).not.toBe('error');

    await heal();
    const retry = transcoderDeps();
    await transcoder.handle(lastPoll, retry.d);
    expect(await note()).toEqual({ status: 'error', error_message: 'Transcription took too long and was stopped.' });
    expect(retry.terminal).toHaveLength(1);
  });

  it('a replayed kickoff that finds a failed chunk: throws until Postgres takes the note write', async () => {
    await transcoder.handle(kickoff, transcoderDeps().d);
    await pool.query(`UPDATE audio_chunks SET status = 'error' WHERE note_id = 'n1' AND idx = 0`);

    await breakFailedWrites();
    await expect(transcoder.handle(kickoff, transcoderDeps().d)).rejects.toThrow(/simulated outage/);
    expect((await note()).status).toBe('transcribing');
    expect(mirrored).toEqual([]);

    await heal();
    await transcoder.handle(kickoff, transcoderDeps().d);
    expect((await note()).status).toBe('error');
  });
});

describe('the summarizer retries a failure it decided on, when Postgres missed it', () => {
  it('no words in the transcript: throws, then the retry marks the note failed', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    const deps = { log, traceId: 't', sharedIntelligence: {}, sharedTemplates: {}, sharedRedaction: {}, geminiCall: {} };
    await breakFailedWrites();
    await expect(summarizer.handle({ noteId: 'n1', workspaceId: 'ws' }, deps)).rejects.toThrow(/simulated outage/);
    expect((await note()).status).toBe('summarizing');
    expect(mirrored).toEqual([]);

    await heal();
    await summarizer.handle({ noteId: 'n1', workspaceId: 'ws' }, deps);
    expect(await note()).toEqual({ status: 'error', error_message: 'No speech was found in this recording.' });
  });
});
