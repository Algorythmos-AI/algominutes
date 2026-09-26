import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, noticeKinds } from './helpers';

// A poll task that decides a chunk can't be transcribed (its speech job
// errored, or the poll budget ran out) fails the chunk and its note in one
// statement, then dead-letters the job, refunds and tells the author. The
// notice goes with a new failure only; the refund with any failed note (it's
// net-guarded, so a second chunk changes nothing). A note that is ready anyway
// gets the dead letter alone. If Postgres misses the write, neither is written
// and the retry decides again; if the attempt dies after the commit, the retry
// finds its chunk failed and runs the mirror and the tail again. Real Postgres;
// Firestore and the speech engines are fakes, and so are the hooks except
// where the ledger is checked.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const assemblyai = require('../../services/transcoder/src/providers/assemblyai.js');

const mirrored: any[] = [];
const fsStub = { doc: () => ({ update: async (data: any) => void mirrored.push(data) }) };
const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const MAX_STT_POLLS = 120;

let googleOp: any = null;
let assemblyOp: any = null;
assemblyai.poll = async () => assemblyOp;

function run(chunkId: string, { poll = 0 } = {}) {
  const hooks: any[] = [];
  const done = handler.handleSttPoll({ kind: 'stt-poll', jobId: 'j', chunkId, noteId: 'n1', workspaceId: 'ws', poll }, {
    db: transcoderDb,
    stt: { checkOperation: async () => googleOp },
    tasks: { enqueue: async () => {} },
    mirror: { db: () => fsStub },
    log,
    storage: {},
    env: { STT_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'test' },
    traceId: 't',
    terminalHooks: { onTranscodeTerminalFailure: async (a: any) => void hooks.push(a) },
  });
  return { hooks, done };
}

const noteStatus = async () => (await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0]?.status;
const chunkStatus = async (id: string) => (await pool.query('SELECT status FROM audio_chunks WHERE id = $1', [id])).rows[0]?.status;

async function seedChunk(idx: number, op: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status, stt_operation_id)
       VALUES ('n1', $1, $2, $3, 'chunks/n1', 'pending', $4) RETURNING id`,
    [idx, idx * 600, (idx + 1) * 600, op],
  );
  return rows[0].id;
}

async function withOutage(table: 'notes' | 'audio_chunks', fn: () => Promise<void>) {
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_poll_outage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated outage'; END $$;
    CREATE TRIGGER test_poll_outage BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_poll_outage();`);
  try { await fn(); } finally {
    await pool.query(`DROP TRIGGER IF EXISTS test_poll_outage ON ${table}; DROP FUNCTION IF EXISTS test_poll_outage();`);
  }
}

let c1: string;
let c2: string;
beforeEach(async () => {
  await resetDb();
  mirrored.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u', { chunksTotal: 2 });
  await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
  googleOp = { done: true, error: { message: 'speech job failed' } };
  assemblyOp = { done: true, error: new Error('assemblyai_transcript_error: x'), lines: [] };
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await repo.getPool().end();
});

describe('a Google chunk poll that fails its chunk', () => {
  beforeEach(async () => {
    c1 = await seedChunk(0, 'operations/1');
    c2 = await seedChunk(1, 'operations/2');
  });

  it('the speech job errored: chunk and note fail together, then the refund and notice', async () => {
    const r = run(c1);
    await r.done;
    expect(await chunkStatus(c1)).toBe('error');
    expect(await noteStatus()).toBe('error');
    expect(mirrored.map((m) => m.status)).toEqual(['error']);
    expect(r.hooks).toHaveLength(1);
    expect(r.hooks[0]).toMatchObject({ deadLetterOnly: false, payload: { reason: 'stt_operation_errored', chunkId: c1 } });
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });

  it("a second chunk failing the same note: its chunk is marked, no second notice, and the first failure's message stays", async () => {
    await run(c1).done;
    googleOp = { done: false };
    const second = run(c2, { poll: MAX_STT_POLLS });
    await second.done;
    expect(await chunkStatus(c2)).toBe('error');
    expect(await noteStatus()).toBe('error');
    expect(second.hooks.map((h) => h.deadLetterOnly)).toEqual([false]);
    expect(await noticeKinds('n1')).toEqual(['note_failed']); // the first chunk's, and no second
    expect((await pool.query(`SELECT error_message FROM notes WHERE id = 'n1'`)).rows[0].error_message)
      .toBe('Transcription failed for part of this recording.');
    expect(mirrored.map((m) => m.errorMessage)).toEqual([
      'Transcription failed for part of this recording.', 'Transcription failed for part of this recording.',
    ]);
  });

  it("a note that moved on after its chunk failed (a regeneration, or ready): the re-drive leaves it alone", async () => {
    for (const status of ['summarizing', 'ready']) {
      mirrored.length = 0;
      await pool.query(`UPDATE audio_chunks SET status = 'error' WHERE id = $1`, [c1]);
      await pool.query(`UPDATE notes SET status = $1, error_message = NULL WHERE id = 'n1'`, [status]);
      const r = run(c1);
      await r.done;
      expect(await noteStatus()).toBe(status);
      expect(mirrored).toEqual([]);
      expect(r.hooks).toEqual([]);
    }
  });

  it('an attempt that died after its commit: the retry mirrors and runs the tail, without a second notice', async () => {
    // The commit alone (chunk and note), with no mirror and no tail after it.
    const noteTerminal = require('@algominutes/db/note-terminal.cjs');
    await noteTerminal.markNoteFailed({
      pool: transcoderDb.pool(), firestore: { doc: () => ({ update: async () => {} }) },
      noteId: 'n1', workspaceId: 'ws', message: 'Transcription failed for part of this recording.',
      log, event: 'stt_operation_errored', retryOnPgError: true, chunkId: c1,
    });
    expect(await chunkStatus(c1)).toBe('error');
    expect(mirrored).toEqual([]);

    const retry = run(c1);
    await retry.done;
    expect(mirrored.map((m) => m.status)).toEqual(['error']);
    expect(retry.hooks.map((h) => [h.deadLetterOnly, h.payload.reason])).toEqual([[false, 'chunk_already_failed']]);
    // The notice was written by the commit that died; the retry adds none.
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });

  it('two chunks failing at the same moment: one new failure between them', async () => {
    // Hold the note so both statements queue behind it, then let them go: the
    // second must read the status the first left, not its own snapshot's.
    const blocker = await pool.connect();
    let a: ReturnType<typeof run>;
    let b: ReturnType<typeof run>;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM notes WHERE id = 'n1' FOR UPDATE`);
      a = run(c1);
      b = run(c2);
      // pg_locks, not pg_stat_activity: the latter is snapshotted per transaction.
      // At a pool of 1 the second waits for a client, not the lock: one waiter.
      const want = Math.min(2, transcoderDb.pool().options.max);
      let waiting = 0;
      for (let i = 0; i < 500 && waiting < want; i++) {
        const { rows } = await blocker.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        waiting = rows[0].n;
        if (waiting < want) await new Promise((r) => setTimeout(r, 10));
      }
      // Proves nothing unless they really queued behind the lock.
      expect(waiting).toBeGreaterThanOrEqual(want);
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    await Promise.all([a!.done, b!.done]);
    // One notice between them: the second read the first's 'error'.
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
    expect([...a.hooks, ...b.hooks].map((h) => h.deadLetterOnly)).toEqual([false, false]);
    expect([await chunkStatus(c1), await chunkStatus(c2)]).toEqual(['error', 'error']);
  });

  it('a re-queue that deleted this run\'s chunks while the verdict waited: the new run is left alone', async () => {
    // The kickoff (markQueued) locks the note, and only later re-queues it and
    // deletes the old run's chunks: the verdict arrives in that gap. (Taking the
    // chunk first here deadlocked with it.)
    const kickoff = await pool.connect();
    let r: ReturnType<typeof run>;
    try {
      await kickoff.query('BEGIN');
      await kickoff.query(`SELECT 1 FROM notes WHERE id = 'n1' FOR UPDATE`);
      r = run(c1);
      let waiting = 0;
      for (let i = 0; i < 500 && waiting < 1; i++) {
        waiting = (await kickoff.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0].n;
        if (waiting < 1) await new Promise((res) => setTimeout(res, 10));
      }
      expect(waiting).toBeGreaterThanOrEqual(1);
      await kickoff.query(`UPDATE notes SET status = 'queued' WHERE id = 'n1'`);
      await kickoff.query(`DELETE FROM audio_chunks WHERE note_id = 'n1'`);
    } finally {
      await kickoff.query('COMMIT');
      kickoff.release();
    }
    await r!.done;
    expect(await noteStatus()).toBe('queued');
    expect(mirrored).toEqual([]);
    expect(r!.hooks).toEqual([]);
  });

  it("a late completion of a failed note's chunk: the note stays failed, the chunk too", async () => {
    await run(c1).done; // the verdict fails the note and its chunk
    const client = await transcoderDb.pool().connect();
    try {
      const gate = await transcoderDb.completeChunkGate(client, { chunkId: c1, noteId: 'n1', workspaceId: 'ws', log });
      expect(gate).toMatchObject({ finished: true, allDone: false, summarizerClaimed: false });
    } finally { client.release(); }
    expect(await noteStatus()).toBe('error');
    expect(await chunkStatus(c1)).toBe('error');
  });

  it('with a chunk and no retry left, a transaction that fails still reports the real error', async () => {
    const noteTerminal = require('@algominutes/db/note-terminal.cjs');
    const seen: Array<{ o: any; m: string }> = [];
    const watch: any = { info: noop, warn: noop, error: (o: any, m: string) => void seen.push({ o, m }), child: () => watch };
    await withOutage('notes', async () => {
      const out = await noteTerminal.markNoteFailed({
        pool: transcoderDb.pool(), firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log: watch,
        event: 'ev', chunkId: c1,
      });
      expect(out).toMatchObject({ pgErrored: true, marked: false });
    });
    const pgFailed = seen.find((l) => l.m === 'ev_pg_failed');
    expect(String(pgFailed?.o.err?.message)).toContain('simulated outage');
  });

  it('a chunk another chain finished: its verdict fails nothing', async () => {
    await pool.query(`UPDATE audio_chunks SET status = 'done' WHERE id = $1`, [c1]);
    const noteTerminal = require('@algominutes/db/note-terminal.cjs');
    const out = await noteTerminal.markNoteFailed({
      pool: transcoderDb.pool(), firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log,
      event: 'stt_operation_errored', retryOnPgError: true, chunkId: c1,
    });
    expect(out).toMatchObject({ superseded: true, marked: false });
    expect(await noteStatus()).toBe('transcribing');
    expect(await chunkStatus(c1)).toBe('done');
  });

  it('the poll budget ran out: the same, as stt_poll_exhausted', async () => {
    googleOp = { done: false };
    const r = run(c1, { poll: MAX_STT_POLLS });
    await r.done;
    expect(await chunkStatus(c1)).toBe('error');
    expect(await noteStatus()).toBe('error');
    expect(r.hooks).toHaveLength(1);
    expect(r.hooks[0]).toMatchObject({ deadLetterOnly: false, payload: { reason: 'stt_poll_exhausted', polls: MAX_STT_POLLS } });
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });

  it('a note that is ready anyway: left ready, its chunk untouched, the dead letter only', async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    const r = run(c1);
    await r.done;
    expect(await noteStatus()).toBe('ready');
    expect(await chunkStatus(c1)).toBe('pending');
    expect(mirrored).toEqual([]);
    expect(r.hooks.map((h) => h.deadLetterOnly)).toEqual([true]);
  });

  it("a task whose workspace isn't the note's: neither the note nor its chunk is touched", async () => {
    const hooks: any[] = [];
    await handler.handleSttPoll({ kind: 'stt-poll', jobId: 'j', chunkId: c1, noteId: 'n1', workspaceId: 'other-ws', poll: 0 }, {
      db: transcoderDb, stt: { checkOperation: async () => googleOp }, tasks: { enqueue: async () => {} },
      mirror: { db: () => fsStub }, log, storage: {}, env: {}, traceId: 't',
      terminalHooks: { onTranscodeTerminalFailure: async (a: any) => void hooks.push(a) },
    });
    expect(await noteStatus()).toBe('transcribing');
    expect(await chunkStatus(c1)).toBe('pending');
    expect(mirrored).toEqual([]);
    expect(hooks).toEqual([]);
  });

  for (const table of ['notes', 'audio_chunks'] as const) {
    it(`Postgres misses the write (${table}): neither is written, and the retry fails the note with the refund`, async () => {
      await withOutage(table, async () => {
        const r = run(c1);
        await expect(r.done).rejects.toThrow('simulated outage');
        expect(r.hooks).toEqual([]);
      });
      expect(await chunkStatus(c1)).toBe('pending');
      expect(await noteStatus()).toBe('transcribing');
      expect(mirrored).toEqual([]);

      const retry = run(c1);
      await retry.done;
      expect(await chunkStatus(c1)).toBe('error');
      expect(await noteStatus()).toBe('error');
      expect(retry.hooks.map((h) => h.deadLetterOnly)).toEqual([false]);
      expect(await noticeKinds('n1')).toEqual(['note_failed']);
    });
  }
});

describe('a whole-file (AssemblyAI) poll that fails its chunk', () => {
  beforeEach(async () => {
    c1 = await seedChunk(0, 'assemblyai:job-1');
    c2 = await seedChunk(1, 'assemblyai:job-2');
  });

  it('the job errored: chunk and note fail together; a second chunk gets the dead letter only', async () => {
    const first = run(c1);
    await first.done;
    expect(await chunkStatus(c1)).toBe('error');
    expect(await noteStatus()).toBe('error');
    expect(first.hooks.map((h) => h.payload.reason)).toEqual(['stt_operation_errored']);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);

    const second = run(c2);
    await second.done;
    expect(await chunkStatus(c2)).toBe('error');
    expect(second.hooks.map((h) => h.deadLetterOnly)).toEqual([false]);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });

  it('the poll budget ran out: chunk and note fail together, as stt_poll_exhausted', async () => {
    assemblyOp = { done: false, error: null, lines: [] };
    const first = run(c1, { poll: MAX_STT_POLLS });
    await first.done;
    expect(await chunkStatus(c1)).toBe('error');
    expect(await noteStatus()).toBe('error');
    expect(first.hooks.map((h) => h.payload.reason)).toEqual(['stt_poll_exhausted']);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);

    const second = run(c2, { poll: MAX_STT_POLLS });
    await second.done;
    expect(await chunkStatus(c2)).toBe('error');
    expect(second.hooks.map((h) => h.deadLetterOnly)).toEqual([false]);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });

  it('Postgres misses the chunk write: the note is left in progress for the retry', async () => {
    await withOutage('audio_chunks', async () => {
      await expect(run(c1).done).rejects.toThrow('simulated outage');
    });
    expect(await noteStatus()).toBe('transcribing');
    const retry = run(c1);
    await retry.done;
    expect(retry.hooks.map((h) => h.deadLetterOnly)).toEqual([false]);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
  });
});

describe('the real tail, on the ledger', () => {
  // The hooks load the TypeScript repo with require(); under vitest that
  // bypasses the transform, so hand them the imported repo.
  for (const spec of ['@algominutes/db/usage-repo.ts', '@algominutes/db/dead-letter-repo.ts']) {
    const p = require.resolve(spec);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: repo } as never;
  }
  const realHooks = require('../../services/transcoder/src/terminal-hooks.js');
  const infos: string[] = [];
  const tailLog: any = { info: (_o: unknown, m: string) => void infos.push(m), warn: noop, error: noop, child: () => tailLog };
  const poll = (chunkId: string, opts: { poll?: number } = {}) => handler.handleSttPoll(
    { kind: 'stt-poll', jobId: 'j', chunkId, noteId: 'n1', workspaceId: 'ws', poll: opts.poll ?? 0 },
    { db: transcoderDb, stt: { checkOperation: async () => googleOp }, tasks: { enqueue: async () => {} },
      mirror: { db: () => fsStub }, log: tailLog, storage: {}, env: {}, traceId: 't', terminalHooks: realHooks },
  );
  const ledger = async () => (await pool.query(
    `SELECT entry_type, minutes::float8 AS m FROM usage_ledger WHERE note_id = 'n1' ORDER BY id`,
  )).rows.map((r: any) => `${r.entry_type} ${r.m}`);
  const deadLetters = async () => (await pool.query(`SELECT count(*)::int AS n FROM dead_letter WHERE note_id = 'n1'`)).rows[0].n;

  beforeEach(async () => {
    infos.length = 0;
    c1 = await seedChunk(0, 'operations/1');
    c2 = await seedChunk(1, 'operations/2');
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('u', 'ws', 'n1', 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
    );
  });

  for (const [site, op, polls, opId] of [
    ['Google, speech job errored', 'google-error', 0, 'operations/9'],
    ['Google, poll budget spent', 'google-pending', MAX_STT_POLLS, 'operations/9'],
    ['whole-file, job errored', 'assembly-error', 0, 'assemblyai:job-9'],
    ['whole-file, poll budget spent', 'assembly-pending', MAX_STT_POLLS, 'assemblyai:job-9'],
  ] as const) {
    it(`${site}: the note is refunded with its failure`, async () => {
      if (op === 'google-pending') googleOp = { done: false };
      if (op === 'assembly-pending') assemblyOp = { done: false, error: null, lines: [] };
      const c = await seedChunk(2, opId);
      await handler.handleSttPoll(
        { kind: 'stt-poll', jobId: 'j', chunkId: c, noteId: 'n1', workspaceId: 'ws', poll: polls },
        { db: transcoderDb, stt: { checkOperation: async () => googleOp }, tasks: { enqueue: async () => {} },
          mirror: { db: () => fsStub }, log: tailLog, storage: {}, env: { STT_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'test' },
          traceId: 't', terminalHooks: realHooks },
      );
      expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
    });
  }

  it('two chunks fail and one attempt is re-driven: refunded once, one notice, a dead letter each', async () => {
    await poll(c1);
    googleOp = { done: false };
    await poll(c2, { poll: MAX_STT_POLLS });
    await poll(c1); // a late chain, or the retry of an attempt that died after its commit
    expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
    expect(infos.filter((m) => m === 'notify_enqueue_skipped_no_config')).toHaveLength(1);
    expect(await deadLetters()).toBe(3);
  });

  it('an attempt that died before its refund: the retry refunds', async () => {
    const noteTerminal = require('@algominutes/db/note-terminal.cjs');
    await noteTerminal.markNoteFailed({
      pool: transcoderDb.pool(), firestore: { doc: () => ({ update: async () => {} }) },
      noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 'stt_operation_errored', retryOnPgError: true, chunkId: c1,
    });
    expect(await ledger()).toEqual(['debit 30']);
    await poll(c1);
    expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
  });
});
