import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, markError } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// markError is Postgres first, then the Firestore mirror (CLAUDE.md §1:
// Postgres is the system of record). It used to log a Postgres failure and
// mirror 'error' anyway, and return normally: the cache said 'error' while
// Postgres kept the old status, and the caller never knew. A Postgres failure
// now throws before the mirror. Real Postgres; a trigger stands in for the
// outage on the notes write.
const breakFailedWrites = () => pool.query(`
  CREATE OR REPLACE FUNCTION test_mark_error_outage() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.status = 'error' THEN RAISE EXCEPTION 'simulated outage'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER test_mark_error_outage BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION test_mark_error_outage();`);
// Deferred to COMMIT: the UPDATE and the refund both run, then the commit fails.
const breakCommit = () => pool.query(`
  CREATE OR REPLACE FUNCTION test_mark_error_commit() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.status = 'error' THEN RAISE EXCEPTION 'commit outage'; END IF; RETURN NEW; END $$;
  CREATE CONSTRAINT TRIGGER test_mark_error_commit AFTER UPDATE ON notes DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION test_mark_error_commit();`);
const heal = () => pool.query(`
  DROP TRIGGER IF EXISTS test_mark_error_outage ON notes; DROP FUNCTION IF EXISTS test_mark_error_outage();
  DROP TRIGGER IF EXISTS test_mark_error_commit ON notes; DROP FUNCTION IF EXISTS test_mark_error_commit();`);

const mirrored: Array<{ path: string; data: Record<string, unknown> }> = [];
const fs = {
  doc: (path: string) => ({ update: async (data: Record<string, unknown>) => void mirrored.push({ path, data }) }),
} as never;
const errors: Array<{ fields: Record<string, unknown>; msg?: string }> = [];
const log = { error: (fields: Record<string, unknown>, msg?: string) => void errors.push({ fields, msg }) };

const note = async () => (await pool.query(`SELECT status, error_message FROM notes WHERE id = 'n1'`)).rows[0];
const ledger = async () => (await pool.query(
  `SELECT entry_type, minutes::float8 AS m, reason FROM usage_ledger WHERE note_id = 'n1' ORDER BY id`,
)).rows.map((r: any) => `${r.entry_type} ${r.m} ${r.reason}`);
const input = {
  noteId: 'n1', workspaceId: 'ws', errorMessage: 'boom', traceId: 'trace-mark-error',
  refund: { reason: 'refund:enqueue_failed', idempotencyKey: 'n1:refund:enqueue' },
};

beforeEach(async () => {
  await heal();
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u'); // status 'queued'
  await pool.query(
    `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
       VALUES ('u', 'ws', 'n1', 'debit', 3, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
  );
  mirrored.length = 0;
  errors.length = 0;
});
afterAll(async () => {
  await heal();
  await pool.end();
  await getPool().end();
});

describe('markError: Postgres first, and a Postgres failure throws before the mirror', () => {
  it('marks, refunds and mirrors when Postgres takes the write', async () => {
    await markError(fs, input, log);
    expect(await note()).toEqual({ status: 'error', error_message: 'boom' });
    expect(await ledger()).toEqual(['debit 3 ingest', 'reversal -3 refund:enqueue_failed']);
    expect(mirrored).toEqual([
      { path: 'workspaces/ws/notes/n1', data: expect.objectContaining({ status: 'error', errorMessage: 'boom' }) },
    ]);
  });

  it('a failed notes write throws, leaves the note as it was, and never touches the Firestore doc', async () => {
    await breakFailedWrites();
    await expect(markError(fs, input, log)).rejects.toThrow('simulated outage');
    expect(await note()).toEqual({ status: 'queued', error_message: null });
    expect(await ledger()).toEqual(['debit 3 ingest']);
    expect(mirrored).toEqual([]);
    // Logged with the note, its workspace and the trace before it is rethrown.
    expect(errors).toContainEqual({
      fields: expect.objectContaining({ noteId: 'n1', workspaceId: 'ws', traceId: 'trace-mark-error', err: expect.any(Error) }),
      msg: 'pg_mark_error_failed',
    });
  });

  it('a COMMIT that fails takes the refund with it, and still nothing is mirrored', async () => {
    await breakCommit();
    await expect(markError(fs, input, log)).rejects.toThrow('commit outage');
    expect(await note()).toEqual({ status: 'queued', error_message: null });
    expect(await ledger()).toEqual(['debit 3 ingest']);
    expect(mirrored).toEqual([]);
  });

  it('once Postgres is back, the same call marks, refunds and mirrors once', async () => {
    await breakFailedWrites();
    await expect(markError(fs, input, log)).rejects.toThrow('simulated outage');
    await heal();
    await markError(fs, input, log);
    expect((await note()).status).toBe('error');
    expect(await ledger()).toEqual(['debit 3 ingest', 'reversal -3 refund:enqueue_failed']);
    expect(mirrored.map((m) => m.data.status)).toEqual(['error']);
  });
});
