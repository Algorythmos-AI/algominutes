import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPool, settleMeasuredLength, grantEntitlement, resolveEntitlement } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// The charge follows the measured length (docs/plans/RELEASE.md PR 3b). The
// kickoff charges the client's claimed length (an iOS import claims none); the
// transcoder measures the audio, and settleMeasuredLength debits or refunds the
// difference, or refuses a recording over the plan's length or the user's
// minutes. Real Postgres; the transcoder's network edges are fakes.
const require = createRequire(import.meta.url);
const { reverseNoteUsage } = require('@algominutes/db/ledger-reversal.cjs');
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws', 'alice');
  await seedNote('n1', 'ws', 'alice');
  await grantEntitlement({ uid: 'alice', reason: 'test' }); // Pro: 1,500 minutes, 4 hours a note
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

// What markQueued writes for a run: one ingest debit, keyed to the run.
const charge = (minutes: number, noteId = 'n1', key = `${noteId}:ingest`) => pool.query(
  `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
     VALUES ('alice', 'ws', $1, 'debit', $2, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM'), 'ingest', $3)`,
  [noteId, minutes, key],
);
const ledger = async (noteId = 'n1') => (await pool.query(
  `SELECT entry_type, minutes::float8 AS m, reason, reverses_id IS NOT NULL AS reverses FROM usage_ledger WHERE note_id = $1 ORDER BY id`,
  [noteId],
)).rows.map((r: any) => `${r.entry_type} ${r.m} ${r.reason}${r.reverses ? ' (reverses)' : ''}`);
const net = async (noteId = 'n1') => Number((await pool.query(`SELECT COALESCE(SUM(minutes), 0)::float8 AS n FROM usage_ledger WHERE note_id = $1`, [noteId])).rows[0].n);
const settle = (measuredSec: number, noteId = 'n1', workspaceId = 'ws') => settleMeasuredLength({ noteId, workspaceId, measuredSec });

describe('settleMeasuredLength', () => {
  it('an import that claimed no length is charged its measured minutes, rounded up', async () => {
    await charge(0);
    expect(await settle(90)).toEqual({ kind: 'settled', chargedMinutes: 2, deltaMinutes: 2 });
    expect(await ledger()).toEqual(['debit 0 ingest', 'debit 2 ingest:measured']);
    expect(await resolveEntitlement('alice')).toMatchObject({ usedMinutes: 2 });
  });

  it('a claim that was too long is refunded the difference, against the run it charged', async () => {
    await charge(10);
    expect(await settle(4 * 60)).toEqual({ kind: 'settled', chargedMinutes: 4, deltaMinutes: -6 });
    expect(await ledger()).toEqual(['debit 10 ingest', 'reversal -6 refund:measured (reverses)']);
    expect(await net()).toBe(4);
  });

  it('a claim that matched writes nothing, and a replay after a settle writes nothing more', async () => {
    await charge(3);
    expect(await settle(150)).toEqual({ kind: 'settled', chargedMinutes: 3, deltaMinutes: 0 });
    await seedNote('n2', 'ws', 'alice');
    await charge(0, 'n2');
    expect((await settle(600, 'n2')).kind).toBe('settled');
    expect(await settle(600, 'n2')).toEqual({ kind: 'settled', chargedMinutes: 10, deltaMinutes: 0 });
    expect(await ledger('n2')).toEqual(['debit 0 ingest', 'debit 10 ingest:measured']);
  });

  it('two replays at once settle once (the note row lock)', async () => {
    await charge(0);
    // Stop every ledger INSERT (not the reads), so both settles are in flight at
    // once: without the note row lock, both would read a net of 0.
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE usage_ledger IN SHARE ROW EXCLUSIVE MODE');
    const both = Promise.allSettled([settle(300), settle(300)]);
    await new Promise((r) => setTimeout(r, 300));
    await blocker.query('COMMIT');
    blocker.release();
    const results = await both;
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const deltas = results.map((r) => (r as PromiseFulfilledResult<{ deltaMinutes: number }>).value.deltaMinutes).sort();
    expect(deltas).toEqual([0, 5]);
    expect(await ledger()).toEqual(['debit 0 ingest', 'debit 5 ingest:measured']);
  });

  it("refuses what the user's minutes don't cover, writing nothing", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 10 });
    await charge(0);
    expect(await settle(20 * 60)).toMatchObject({ kind: 'over_quota', neededMinutes: 20 });
    expect(await ledger()).toEqual(['debit 0 ingest']);
    // Exactly what's left is fine.
    expect(await settle(10 * 60)).toMatchObject({ kind: 'settled', deltaMinutes: 10 });
  });

  it("refuses a recording longer than the plan's longest, writing nothing", async () => {
    await charge(0);
    expect(await settle(4 * 3600 + 1)).toEqual({ kind: 'too_long', maxSec: 4 * 3600 });
    expect(await ledger()).toEqual(['debit 0 ingest']);
    expect((await settle(4 * 3600)).kind).toBe('settled');
  });

  it("settles a notetaker's meeting but never refuses it: its minutes were reserved when the bot was sent", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 10 });
    await pool.query(`UPDATE notes SET source_type = 'online_meeting' WHERE id = 'n1'`);
    await charge(5);
    expect(await settle(5 * 3600)).toEqual({ kind: 'settled', chargedMinutes: 300, deltaMinutes: 295 });
  });

  it("finds nothing in another workspace, or for a deleted note, and writes nothing", async () => {
    await charge(0);
    expect(await settle(60, 'n1', 'ws-other')).toEqual({ kind: 'not_found' });
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect(await settle(60)).toEqual({ kind: 'not_found' });
    expect(await ledger()).toEqual(['debit 0 ingest']);
  });

  it('a run with no ingest debit has nothing to settle', async () => {
    expect(await settle(600)).toEqual({ kind: 'settled', chargedMinutes: 0, deltaMinutes: 0 });
    expect(await count('SELECT 1 FROM usage_ledger')).toBe(0);
  });

  it('leaves a run another attempt already failed and refunded (no phantom charge)', async () => {
    await charge(5);
    await reverseNoteUsage(pool, { noteId: 'n1', reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' });
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
    expect(await settle(5 * 60)).toEqual({ kind: 'moved_on', status: 'error' });
    expect(await ledger()).toEqual(['debit 5 ingest', 'reversal -5 refund:transcode_failed (reverses)']);
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    expect((await settle(9 * 60)).kind).toBe('moved_on');
  });

  it("two settles of the user's different notes can't both spend the last minutes (the meter lock)", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 15 });
    await seedNote('n2', 'ws', 'alice');
    await charge(0);
    await charge(0, 'n2');
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['meter:alice']);
    const both = Promise.all([settle(10 * 60, 'n1'), settle(10 * 60, 'n2')]);
    await new Promise((r) => setTimeout(r, 300));
    await blocker.query('COMMIT');
    blocker.release();
    expect((await both).map((r) => r.kind).sort()).toEqual(['over_quota', 'settled']);
    expect(await resolveEntitlement('alice')).toMatchObject({ usedMinutes: 10 });
  });

  it('a second, different measurement of the same run (a re-download) is its own adjustment', async () => {
    await charge(0);
    expect(await settle(600)).toMatchObject({ deltaMinutes: 10 });
    expect(await settle(660)).toMatchObject({ deltaMinutes: 1 });
    expect(await settle(540)).toMatchObject({ deltaMinutes: -2 });
    expect(await ledger()).toEqual(['debit 0 ingest', 'debit 10 ingest:measured', 'debit 1 ingest:measured', 'reversal -2 refund:measured (reverses)']);
    expect(await net()).toBe(9);
  });

  it("checks the run's own billing month, where the adjustment lands", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 10 });
    // Kicked off last month, which already has 8 minutes used; this month has none.
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('alice', 'ws', 'n1', 'debit', 0, '2026-08', 'ingest', 'n1:ingest'),
                ('alice', 'ws', NULL, 'debit', 8, '2026-08', 'ingest', 'other:ingest')`,
    );
    expect(await settle(5 * 60)).toMatchObject({ kind: 'over_quota', neededMinutes: 5 });
    expect(await settle(2 * 60)).toMatchObject({ kind: 'settled', deltaMinutes: 2 });
    expect((await pool.query(`SELECT billing_period FROM usage_ledger WHERE reason = 'ingest:measured'`)).rows).toEqual([{ billing_period: '2026-08' }]);
  });

  it("a length already accepted isn't refused on a replay after the plan changed", async () => {
    await charge(3 * 60); // a 3-hour recording, claimed and charged on Pro
    expect(await settle(3 * 3600)).toMatchObject({ kind: 'settled', deltaMinutes: 0 });
    await pool.query(`DELETE FROM entitlement_grants WHERE uid = 'alice'`); // back to the free plan's 2-hour cap
    expect(await settle(3 * 3600)).toMatchObject({ kind: 'settled', deltaMinutes: 0 });
  });

  it("a later failure's refund gives back the whole run, adjustment included", async () => {
    await charge(0);
    await settle(600);
    await reverseNoteUsage(pool, { noteId: 'n1', reason: 'refund:transcode_failed', idempotencyKey: 'n1:refund:transcode' });
    expect(await net()).toBe(0);
  });
});

describe('the transcoder settles before any paid work', () => {
  const noop = () => {};
  const log: any = { info: noop, warn: noop, error: noop, child: () => log };
  const deadLetters: unknown[] = [];
  const paid: string[] = [];
  function deps(duration: number) {
    return {
      log, env: {}, traceId: 't-measured', db: transcoderDb,
      storage: { downloadToLocal: async (_p: string, local: string) => { fs.writeFileSync(local, 'audio'); } },
      ffmpeg: {
        ensureTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'measured-')), cleanupTempDir: noop,
        probeDuration: async () => duration,
      },
      stt: {}, youtube: {}, tasks: {},
      mirror: { mirrorStatus: async () => {}, mirrorProgress: async () => {}, db: () => ({ doc: () => ({ update: async () => {} }) }) },
      fastPath: { run: async () => { paid.push('fast'); } },
      terminalHooks: { onTranscodeTerminalFailure: async (a: unknown) => { deadLetters.push(a); } },
      meter: { settleMeasuredLength },
    };
  }
  const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', uid: 'alice', type: 'recording', storagePath: 'recordings/ws/n1.m4a' };

  beforeEach(() => { deadLetters.length = 0; paid.length = 0; });

  it('too long: the note fails with a full refund and its reason, no paid work, and no dead letter', async () => {
    await charge(0);
    const said: string[] = [];
    const heard: any = { info: noop, warn: (_o: unknown, m: string) => void said.push(m), error: (_o: unknown, m: string) => void said.push(m), child: () => heard };
    await handler.handle(kickoff, { ...deps(4 * 3600 + 60), log: heard });
    // The user's recording, refused: not a pipeline failure for the note_failed alert (RELEASE.md PR 15b).
    expect(said).toContain('note_refused');
    expect(said).not.toContain('note_failed');
    expect((await pool.query(`SELECT status, error_message FROM notes WHERE id = 'n1'`)).rows[0])
      .toEqual({ status: 'error', error_message: expect.stringMatching(/longer than 4 hours/) });
    expect(await net()).toBe(0);
    expect(paid).toEqual([]);
    expect(deadLetters).toEqual([]);
  });

  it('a run another attempt failed while this one measured is acknowledged: no charge, no paid work', async () => {
    await charge(0);
    // This attempt passed the kickoff's status checks; another attempt fails
    // the note while it downloads and measures (the window the audit found).
    const d = deps(90);
    const racing = {
      ...d,
      ffmpeg: {
        ...d.ffmpeg,
        probeDuration: async () => {
          await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
          return 90;
        },
      },
    };
    await expect(handler.handle(kickoff, racing)).resolves.toBeUndefined();
    expect(await ledger()).toEqual(['debit 0 ingest']);
    expect(paid).toEqual([]);
  });

  it('within the minutes: charged the measured length, then the paid work runs', async () => {
    await charge(0);
    await handler.handle(kickoff, deps(90));
    expect(await ledger()).toEqual(['debit 0 ingest', 'debit 2 ingest:measured']);
    expect(paid).toEqual(['fast']);
  });
});
