import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
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
const heal = () => pool.query(`DROP TRIGGER IF EXISTS test_ledger_outage ON usage_ledger; DROP FUNCTION IF EXISTS test_ledger_outage();`);

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
    expect(await stuck()).toEqual({ failed: true, refunded: true });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:stuck']);
    expect(await fail()).toMatchObject({ marked: true, refunded: false });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:stuck']);
  });

  it("one transaction: if the refund can't be written, the note isn't failed either", async () => {
    await breakLedger();
    await expect(stuck()).rejects.toThrow('ledger outage');
    expect(await status()).toBe('transcribing');
  });
});

describe('the summarizer', () => {
  it('"No speech was found" refunds the recording with the failure', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    const deps = { log, traceId: 't', sharedIntelligence: {}, sharedTemplates: {}, sharedRedaction: {}, geminiCall: {} };
    await summarizer.handle({ noteId: 'n1', workspaceId: 'ws' }, deps);
    expect(await status()).toBe('error');
    expect(await ledger()).toEqual(['debit 30', 'reversal -30 refund:summary_failed']);
  });
});
