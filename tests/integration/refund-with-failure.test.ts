import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import pg from 'pg';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A failed note's refund is written in the failure's own transaction, under
// the note's row lock (ledger-reversal.cjs), by markNoteFailed and by the
// sweep's failStuckNote. A crash can't commit the failure without it, a kickoff
// (markQueued locks the same row) sees both or neither, and a second refunder
// finds the net at 0. Real Postgres; a trigger stands in for a failed ledger
// write.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const fsStub = { doc: () => ({ update: async () => {} }) };
for (const [id, exports] of [
  ['firebase-admin/firestore', { getFirestore: () => fsStub }],
  ['firebase-admin/app', { initializeApp: () => {}, getApps: () => [{}] }],
] as const) {
  const p = require.resolve(id);
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as never;
}
const { markNoteFailed } = require('@algominutes/db/note-terminal.cjs');
const summarizer = require('../../services/summarizer/src/handler.js');

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const transcode = { reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' };
const fail = (extra: Record<string, unknown> = {}) => markNoteFailed({
  pool, firestore: fsStub, noteId: 'n1', workspaceId: 'ws', message: 'x', log, event: 't', refund: transcode, ...extra,
});
const status = async () => (await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status;
const ledger = async () => (await pool.query(
  `SELECT entry_type, minutes::float8 AS m, reason FROM usage_ledger WHERE note_id = 'n1' ORDER BY id`,
)).rows.map((r: any) => `${r.entry_type} ${r.m}${r.reason === 'ingest' ? '' : ` ${r.reason}`}`);
const breakLedger = () => pool.query(`
  CREATE OR REPLACE FUNCTION test_ledger_outage() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'ledger outage'; END $$;
  CREATE TRIGGER test_ledger_outage BEFORE INSERT ON usage_ledger FOR EACH ROW EXECUTE FUNCTION test_ledger_outage();`);
const heal = () => pool.query(`
  DROP TRIGGER IF EXISTS test_ledger_outage ON usage_ledger; DROP FUNCTION IF EXISTS test_ledger_outage();
  DROP TRIGGER IF EXISTS test_ledger_slow ON usage_ledger; DROP FUNCTION IF EXISTS test_ledger_slow();
  DROP TRIGGER IF EXISTS test_commit_outage ON notes; DROP FUNCTION IF EXISTS test_commit_outage();`);
const messages: string[] = [];
const mirrored: any[] = [];
const watchLog: any = { info: noop, warn: noop, error: (_o: unknown, m: string) => void messages.push(m), child: () => watchLog };
const watchFs = { doc: () => ({ update: async (d: any) => void mirrored.push(d) }) };

beforeEach(async () => {
  await heal();
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
  await pool.query(
    `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
       VALUES ('u', 'ws', 'n1', 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
  );
});
afterAll(async () => {
  await heal();
  await summarizer.pool().end();
  await pool.end();
  await repo.getPool().end();
});

describe('markNoteFailed with a refund', () => {
  it('fails the note and refunds it together; a second failure refunds nothing', async () => {
    expect(await fail()).toMatchObject({ failed: true, marked: true, refunded: true });
    expect(await status()).toBe('error');
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:transcode_failed']);
    expect(await fail()).toMatchObject({ failed: false, marked: true, refunded: false });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:transcode_failed']);
  });

  it("one transaction: if the refund can't be written, the note isn't failed either (and the task retries)", async () => {
    await breakLedger();
    await expect(fail({ retryOnPgError: true })).rejects.toThrow('ledger outage');
    expect(await status()).toBe('transcribing');
    expect(await ledger()).toEqual(['debit 30']);
    await heal();
    expect(await fail({ retryOnPgError: true })).toMatchObject({ failed: true, refunded: true });
  });

  it("no retry left (a last attempt): a refund that can't be written is lost, but the note is failed, so the stores agree", async () => {
    await breakLedger();
    messages.length = 0;
    mirrored.length = 0;
    const r = await fail({ log: watchLog, firestore: watchFs });
    expect(r).toMatchObject({ failed: true, marked: true, pgErrored: false, refunded: false });
    expect(await status()).toBe('error');
    expect(mirrored.map((m) => m.status)).toEqual(['error']);
    expect(await ledger()).toEqual(['debit 30']);
    expect(messages).toContain('t_refund_lost');
  });

  it('a COMMIT that fails takes the refund with it: neither lands', async () => {
    // Deferred to COMMIT, so only a refund on the same transaction rolls back.
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_commit_outage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'error' THEN RAISE EXCEPTION 'commit outage'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_commit_outage AFTER UPDATE ON notes DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION test_commit_outage();`);
    await expect(fail({ retryOnPgError: true })).rejects.toThrow('commit outage');
    expect(await status()).toBe('transcribing');
    expect(await ledger()).toEqual(['debit 30']);
  });

  it('a kickoff (it locks the note row) waits for the failure, then sees its refund too', async () => {
    // Hold the failure between its UPDATE and its COMMIT.
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_ledger_slow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$;
      CREATE TRIGGER test_ledger_slow BEFORE INSERT ON usage_ledger FOR EACH ROW EXECUTE FUNCTION test_ledger_slow();`);
    const kickoff = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await kickoff.connect();
    try {
      const failing = fail();
      await new Promise((r) => setTimeout(r, 150));
      await kickoff.query('BEGIN');
      await kickoff.query(`SELECT 1 FROM notes WHERE id = 'n1' FOR UPDATE`);
      const seen = (await kickoff.query(
        `SELECT (SELECT status FROM notes WHERE id = 'n1') AS status,
                (SELECT COALESCE(SUM(minutes), 0)::float8 FROM usage_ledger WHERE note_id = 'n1') AS net`,
      )).rows[0];
      await kickoff.query('COMMIT');
      await failing;
      expect(seen).toEqual({ status: 'error', net: 0 });
    } finally {
      await kickoff.end();
    }
  });

  it('without a refund (a regeneration), the charge stands', async () => {
    expect(await fail({ refund: null })).toMatchObject({ failed: true, refunded: false });
    expect(await ledger()).toEqual(['debit 30']);
  });

  it('a ready note is neither failed nor refunded', async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    expect(await fail()).toMatchObject({ marked: false, refunded: false });
    expect(await ledger()).toEqual(['debit 30']);
  });
});

describe("the sweep's failStuckNote with a refund", () => {
  const stuck = () => repo.failStuckNote(fsStub as never, {
    noteId: 'n1', workspaceId: 'ws', olderThanMs: 60_000, message: 'stuck',
    refund: { reason: 'refund:stuck', idempotencyKey: 'n1:refund:stuck' },
  }, log);
  beforeEach(async () => {
    await pool.query(`UPDATE notes SET updated_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`);
  });

  it('fails and refunds together; a worker failing it after refunds nothing more', async () => {
    expect(await stuck()).toEqual({ failed: true, refunded: true, regeneration: false, notice: expect.objectContaining({ kind: 'note_failed', noteId: 'n1' }) });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:stuck']);
    expect(await fail()).toMatchObject({ marked: true, refunded: false });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:stuck']);
  });

  it("a stuck regeneration is failed and told, but the recording's charge stands", async () => {
    // The regeneration's claim (claimSummaryRegeneration) marks the note.
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 2, summary_requested_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`);
    await pool.query(`UPDATE notes SET updated_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`);
    expect(await stuck()).toMatchObject({ failed: true, refunded: false, regeneration: true, notice: expect.objectContaining({ kind: 'note_failed' }) });
    expect(await status()).toBe('error');
    expect(await ledger()).toEqual(['debit 30']);
  });

  it("a pipeline summary stuck after an earlier regeneration failed is still refunded: a re-queue clears the mark", async () => {
    await pool.query(`UPDATE notes SET status = 'error', summary_requested_at = NOW() - INTERVAL '1 day' WHERE id = 'n1'`);
    const docs = { doc: () => ({ update: async () => {} }) } as never;
    await repo.markQueued(docs, { noteId: 'n1', workspaceId: 'ws', authorUid: 'u', sourceType: 'recording' }, log);
    expect((await pool.query(`SELECT summary_requested_at FROM notes WHERE id = 'n1'`)).rows[0].summary_requested_at).toBeNull();
    await pool.query(`UPDATE notes SET status = 'summarizing', updated_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`);
    expect(await stuck()).toMatchObject({ failed: true, refunded: true, regeneration: false });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:stuck']);
  });

  it("one transaction: if the refund can't be written, the note isn't failed either", async () => {
    await breakLedger();
    await expect(stuck()).rejects.toThrow('ledger outage');
    expect(await status()).toBe('transcribing');
  });

  it('a COMMIT that fails takes the refund with it', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_commit_outage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'error' THEN RAISE EXCEPTION 'commit outage'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_commit_outage AFTER UPDATE ON notes DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION test_commit_outage();`);
    await expect(stuck()).rejects.toThrow('commit outage');
    expect(await ledger()).toEqual(['debit 30']);
  });
});

describe('the summarizer', () => {
  it('"No speech was found" on a regeneration keeps the charge', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 3 WHERE id = 'n1'`);
    const deps = { log, traceId: 't', sharedIntelligence: {}, sharedTemplates: {}, sharedRedaction: {}, geminiCall: {} };
    await summarizer.handle({ noteId: 'n1', workspaceId: 'ws', summaryGeneration: 3 }, deps);
    expect(await status()).toBe('error');
    expect(await ledger()).toEqual(['debit 30']);
  });

  it('"No speech was found" refunds the recording with the failure', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    const deps = { log, traceId: 't', sharedIntelligence: {}, sharedTemplates: {}, sharedRedaction: {}, geminiCall: {} };
    await summarizer.handle({ noteId: 'n1', workspaceId: 'ws' }, deps);
    expect(await status()).toBe('error');
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:summary_failed']);
  });
});
