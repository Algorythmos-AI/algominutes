import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// One dead letter per lost piece of work (RELEASE.md PR 5a; audit Q2–Q4, Q7): keyed queue:note:run:chunk,
// written with the failure so a crash after its commit can't lose it, and a replay, a re-drive or the caller's
// own best-effort record of the same work writes nothing more. Real Postgres.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const { markNoteFailed } = require('@algominutes/db/note-terminal.cjs');
const { reasonFor } = require('../../services/transcoder/src/last-attempt.js');

const infos: string[] = [];
const errors: string[] = [];
const log: any = { info: (_o: unknown, m: string) => void infos.push(m), warn: () => {}, error: (_o: unknown, m: string) => void errors.push(m), child: () => log };
const fsStub = { doc: () => ({ update: async () => {} }) };
const rows = async () => (await pool.query(
  `SELECT queue, reason, dedupe_key, error, attempts FROM dead_letter WHERE note_id = 'n1' ORDER BY id`,
)).rows;
const record = (over: Record<string, unknown> = {}) => repo.recordDeadLetter({
  queue: 'transcode', noteId: 'n1', workspaceId: 'ws', payload: { kind: 'stt-poll' }, error: 'boom', attempts: 5, traceId: 't', reason: 'stt_poll_failed', ...over,
});
const fail = (over: Record<string, unknown> = {}) => markNoteFailed({
  pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 't', enqueueNotice: async () => {},
  deadLetter: { queue: 'transcode', payload: { kind: 'kickoff' }, error: 'boom', attempts: 5, reason: 'transcode_failed' },
  ...over,
});

beforeEach(async () => {
  infos.length = 0;
  errors.length = 0;
  await pool.query(`DROP TRIGGER IF EXISTS test_dl_refuse ON dead_letter; DROP FUNCTION IF EXISTS test_dl_refuse();`);
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
});
afterAll(async () => {
  await pool.query(`DROP TRIGGER IF EXISTS test_dl_refuse ON dead_letter; DROP FUNCTION IF EXISTS test_dl_refuse();`);
  await pool.end();
  await repo.getPool().end();
});

describe('recordDeadLetter', () => {
  it('the same work twice is one row; the second says it was a duplicate, with the kept id', async () => {
    const first = await record();
    const second = await record({ reason: 'chunk_already_failed', error: 'a different error' });
    expect(first.duplicate).toBeUndefined();
    expect(second).toEqual({ id: first.id, duplicate: true });
    expect(await rows()).toEqual([{ queue: 'transcode', reason: 'stt_poll_failed', dedupe_key: 'transcode:n1:0:0:', error: 'boom', attempts: 5 }]);
  });

  it('another chunk, another queue or a new run of the note is its own loss', async () => {
    await record({ chunkId: 'c1' });
    await record({ chunkId: 'c2' });
    await record({ queue: 'summarize', reason: 'summarize_failed' });
    await pool.query(`UPDATE notes SET run_seq = run_seq + 1 WHERE id = 'n1'`);
    await record({ chunkId: 'c1' });
    expect((await rows()).map((r: any) => r.dedupe_key)).toEqual(['transcode:n1:0:0:c1', 'transcode:n1:0:0:c2', 'summarize:n1:0:0:', 'transcode:n1:1:0:c1']);
  });

  it("a note that can't be read (gone) still gets its rows, never deduped (Q3)", async () => {
    await repo.recordDeadLetter({ queue: 'transcode', noteId: 'gone', workspaceId: 'ws', error: 'x' });
    await repo.recordDeadLetter({ queue: 'transcode', noteId: 'gone', workspaceId: 'ws', error: 'x' });
    const kept = (await pool.query(`SELECT dedupe_key FROM dead_letter WHERE note_id = 'gone'`)).rows;
    expect(kept).toEqual([{ dedupe_key: null }, { dedupe_key: null }]);
  });

  it("another workspace's note id gets no key of that note's", async () => {
    await seedWorkspace('ws-b', 'u');
    await repo.recordDeadLetter({ queue: 'transcode', noteId: 'n1', workspaceId: 'ws-b', error: 'x' });
    expect((await pool.query(`SELECT dedupe_key FROM dead_letter WHERE workspace_id = 'ws-b'`)).rows).toEqual([{ dedupe_key: null }]);
  });
});

describe('markNoteFailed with its dead letter', () => {
  it("writes it with the failure, once: a replay and the caller's own record of the same work write nothing", async () => {
    const r = await fail();
    expect(r.marked).toBe(true);
    expect(r.deadLetterId).toEqual(expect.any(Number));
    expect(r.deadLetterDuplicate).toBe(false);
    const again = await fail();
    expect(again.deadLetterId).toBeNull();
    expect(again.deadLetterDuplicate).toBe(true);
    expect((await record({ reason: 'transcode_failed' })).duplicate).toBe(true);
    expect(await rows()).toEqual([{ queue: 'transcode', reason: 'transcode_failed', dedupe_key: 'transcode:n1:0:0:', error: 'boom', attempts: 5 }]);
    // One dead_letter_recorded (the alert counts it); the rest say they were already there.
    expect(infos.filter((m) => m === 'dead_letter_recorded')).toHaveLength(1);
    expect(infos.filter((m) => m === 'dead_letter_already_recorded')).toHaveLength(1);
  });

  it('commits with the failure: nothing after the commit is needed for it to exist (a crash there loses nothing)', async () => {
    await fail({ refund: { reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' } });
    expect(await rows()).toHaveLength(1);
  });

  it('a refund that fails rolls the failure back, and the failure written after it still carries the one dead letter', async () => {
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('u', 'ws', 'n1', 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_dl_ledger_outage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger outage'; END $$;
      CREATE TRIGGER test_dl_ledger_outage BEFORE INSERT ON usage_ledger FOR EACH ROW EXECUTE FUNCTION test_dl_ledger_outage();`);
    try {
      const r = await fail({ refund: { reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' } });
      expect([r.marked, r.refunded]).toEqual([true, false]);
      expect(await rows()).toHaveLength(1);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_dl_ledger_outage ON usage_ledger; DROP FUNCTION IF EXISTS test_dl_ledger_outage();`);
    }
  });

  it('a regeneration that fails is its own loss: the same run, a new summary generation, a second row', async () => {
    await fail({ deadLetter: { queue: 'summarize', payload: {}, error: 'first', reason: 'summarize_failed' } });
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = summary_generation + 1 WHERE id = 'n1'`);
    const again = await fail({ deadLetter: { queue: 'summarize', payload: {}, error: 'second', reason: 'summarize_failed' } });
    expect(again.deadLetterDuplicate).toBe(false);
    expect((await rows()).map((r: any) => r.dedupe_key)).toEqual(['summarize:n1:0:0:', 'summarize:n1:0:1:']);
  });

  it("the caller's own record agrees with the failure's key at any generation: a duplicate, not a second row", async () => {
    await pool.query(`UPDATE notes SET summary_generation = 3 WHERE id = 'n1'`);
    await fail({ deadLetter: { queue: 'summarize', payload: {}, error: 'boom', reason: 'summarize_failed' } });
    expect((await record({ queue: 'summarize', reason: 'summarize_failed' })).duplicate).toBe(true);
    expect((await rows()).map((r: any) => r.dedupe_key)).toEqual(['summarize:n1:0:3:']);
  });

  it('NUL bytes from a tool (Postgres refuses them) are stripped: the failure and its dead letter land', async () => {
    const r = await fail({ deadLetter: { queue: 'transcode', payload: { stderr: 'bad\u0000frame' }, error: 'ffprobe\u0000 died', reason: 'duration_unreadable' } });
    expect(r.marked).toBe(true);
    expect(r.deadLetterId).toEqual(expect.any(Number));
    const [row] = (await pool.query(`SELECT error, payload FROM dead_letter WHERE note_id = 'n1'`)).rows;
    expect(row).toEqual({ error: 'ffprobe died', payload: { stderr: 'badframe' } });
    expect((await repo.recordDeadLetter({ queue: 'embed', noteId: 'n1', workspaceId: 'ws', error: 'x\u0000y', payload: { a: '\u0000' } })).id).toEqual(expect.any(Number));
  });

  it("a dead letter that can't go with the failure never costs the failure: it lands, and the caller records it", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_dl_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'dead_letter unavailable'; END $$;
      CREATE TRIGGER test_dl_refuse BEFORE INSERT ON dead_letter FOR EACH ROW EXECUTE FUNCTION test_dl_refuse();`);
    for (const refund of [null, { reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' }]) {
      await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
      errors.length = 0;
      const r = await fail({ refund });
      expect([r.marked, r.pgErrored, r.deadLetterId, r.deadLetterDuplicate]).toEqual([true, false, null, false]);
      expect(errors).toContain('t_dead_letter_with_failure_failed');
      expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('error');
    }
  });

  it('a caller with no dead letter runs the statement it always did: dead_letter untouched', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_dl_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'dead_letter unavailable'; END $$;
      CREATE TRIGGER test_dl_refuse BEFORE INSERT ON dead_letter FOR EACH ROW EXECUTE FUNCTION test_dl_refuse();`);
    const r = await fail({ deadLetter: null });
    expect([r.marked, r.deadLetterId, r.deadLetterDuplicate]).toEqual([true, null, false]);
    expect(errors.filter((m) => m.includes('dead_letter'))).toEqual([]);
  });

  it("isn't written for a note this doesn't mark (ready): that loss is the caller's to record", async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    const r = await fail();
    expect([r.marked, r.deadLetterId, r.deadLetterDuplicate]).toEqual([false, null, false]);
    expect(await rows()).toEqual([]);
  });
});

describe("the last attempt's reason, from the task (Q7)", () => {
  it('a poll at its limit is stt_poll_exhausted, earlier stt_poll_failed; anything else transcode_failed', () => {
    expect(reasonFor({ kind: 'stt-poll', poll: 120 })).toBe('stt_poll_exhausted');
    expect(reasonFor({ kind: 'stt-poll', poll: 7 })).toBe('stt_poll_failed');
    expect(reasonFor({ kind: 'kickoff' })).toBe('transcode_failed');
  });
});
