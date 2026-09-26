import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, markQueued, reverseUsageForNote } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, quietLog } from './helpers';

// One debit per run. A note refunded after a failed run is charged again when
// it's re-queued (the re-run is real work), and that run's refund pays out
// again. Per-note keys made the re-run free and silently refused the second
// refund. A failure that wasn't refunded keeps its charge, and the retry isn't
// charged twice. Real Postgres; Firestore is a fake.
const docs = new Map<string, Record<string, unknown>>();
const fs = {
  doc: (path: string) => ({
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
  }),
} as never;
const queue = () => markQueued(fs, {
  noteId: 'n1', workspaceId: 'ws-a', authorUid: 'alice', sourceType: 'recording',
  storagePath: 'recordings/ws-a/n1.aac', meter: { minutes: 30, idempotencyKey: 'n1:ingest' },
}, quietLog);
const fail = () => pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
const refund = () => reverseUsageForNote({ noteId: 'n1', reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' });
const ledger = async () => (await pool.query(
  `SELECT entry_type, minutes::float8 AS m FROM usage_ledger WHERE note_id = 'n1' ORDER BY id`,
)).rows.map((r: any) => `${r.entry_type} ${r.m}`);
const net = async () => Number((await pool.query(`SELECT COALESCE(SUM(minutes), 0)::float8 AS n FROM usage_ledger WHERE note_id = 'n1'`)).rows[0].n);

beforeEach(async () => {
  await resetDb();
  docs.clear();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  docs.set('workspaces/ws-a/notes/n1', { authorId: 'alice', status: 'uploading' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('metering, one run at a time', () => {
  it('a refunded run, re-queued: charged again, and its failure refunded again', async () => {
    await queue();
    await fail(); await refund();
    expect(await net()).toBe(0);

    await queue();
    expect(await net()).toBe(30);
    await fail(); await refund();
    expect(await ledger()).toEqual(['debit 30', 'reversal -30', 'debit 30', 'reversal -30']);
    expect(await net()).toBe(0);
  });

  it("a failure that wasn't refunded keeps its charge: the retry isn't charged twice", async () => {
    await queue();
    await fail();
    await queue();
    expect(await ledger()).toEqual(['debit 30']);
    // ...and if the retry fails too, the one charge comes back once.
    await fail(); await refund(); await refund();
    expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
  });

  it("a deleted note's key met again by a re-used id: logged, not silently free", async () => {
    // A deleted note's ledger rows keep their keys but lose their note_id.
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('alice', 'ws-a', NULL, 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
    );
    const errors: string[] = [];
    await markQueued(fs, {
      noteId: 'n1', workspaceId: 'ws-a', authorUid: 'alice', sourceType: 'recording',
      storagePath: 'recordings/ws-a/n1.aac', meter: { minutes: 30, idempotencyKey: 'n1:ingest' },
    }, { ...quietLog, error: (_o: unknown, m?: string) => void errors.push(String(m)) });
    expect(errors).toContain('meter_debit_key_taken');
  });

  it('a replayed refund of the same run is a no-op', async () => {
    await queue();
    await fail();
    expect((await refund()).applied).toBe(true);
    expect((await refund()).applied).toBe(false);
    expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
  });
});
