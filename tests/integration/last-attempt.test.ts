import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The queue's last attempt at a task that kept throwing fails the note, then
// dead-letters the job, refunds and tells the author. The refund runs for any
// note Postgres has failed (it's net-guarded); the notice only for a new
// failure. A note that is ready anyway (the attempt threw after its commit)
// gets the dead letter alone, as does one Postgres couldn't be asked about. A
// note that is gone gets nothing. Real Postgres; Firestore and the hooks are
// fakes.
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
const transcoderLast = require('../../services/transcoder/src/last-attempt.js');
const summarizerLast = require('../../services/summarizer/src/last-attempt.js');
const summarizer = require('../../services/summarizer/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const noteTerminal = require('@algominutes/db/note-terminal.cjs');

const noop = () => {};
const warns: string[] = [];
const log: any = { info: noop, error: noop, warn: (_o: unknown, m: string) => void warns.push(m), child: () => log };
const headers = { 'x-cloudtasks-taskretrycount': '4' };
const status = async () => (await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0]?.status;

function transcoder() {
  const hooks: any[] = [];
  const run = (body: any) => transcoderLast.onLastAttempt({
    body, headers, err: new Error('boom'), noteTerminal, log, traceId: 't',
    db: transcoderDb, mirror: { db: () => fsStub },
    terminalHooks: { onTranscodeTerminalFailure: async (a: any) => void hooks.push(a) },
  });
  return { hooks, run };
}
function summarizerRun() {
  const hooks: any[] = [];
  const run = (body: any) => summarizerLast.onLastAttempt({
    body, headers, err: new Error('boom'), markNoteFailed: summarizer.markNoteFailed, pool: summarizer.pool, log, traceId: 't',
    terminalHooks: { onSummarizeTerminalFailure: async (a: any) => void hooks.push(a) },
  });
  return { hooks, run };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', type: 'recording', storagePath: 'recordings/ws/n1.aac' };

beforeEach(async () => {
  await resetDb();
  mirrored.length = 0;
  warns.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await summarizer.pool().end();
  await pool.end();
  await repo.getPool().end();
});

describe('the transcoder, last attempt', () => {
  it('a note still in progress: failed in both stores, then the hooks run once, with the attempt count', async () => {
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    const t = transcoder();
    expect(await t.run(kickoff)).toEqual({ failed: true });
    expect(await status()).toBe('error');
    expect(mirrored.map((m) => m.status)).toEqual(['error']);
    expect(t.hooks).toHaveLength(1);
    expect(t.hooks[0]).toMatchObject({ noteId: 'n1', workspaceId: 'ws', attempts: 5, deadLetterOnly: false, notify: true, payload: { kind: 'kickoff', storagePath: 'recordings/ws/n1.aac' } });
  });

  it('a note that is ready anyway: left ready; the dead letter records the lost work, with no refund or notice', async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    const t = transcoder();
    expect(await t.run(kickoff)).toEqual({ failed: false });
    expect(await status()).toBe('ready');
    expect(mirrored).toEqual([]);
    expect(t.hooks.map((h) => h.deadLetterOnly)).toEqual([true]);
    expect(warns).toContain('transcoder_last_attempt_dead_letter_only');
  });

  it("a note already failed (another chunk's last attempt got there first): the refund (a no-op if made), no second notice; its message kept", async () => {
    await pool.query(`UPDATE notes SET status = 'error', error_message = 'The first failure.' WHERE id = 'n1'`);
    const t = transcoder();
    expect(await t.run(kickoff)).toEqual({ failed: false });
    expect(t.hooks.map((h) => [h.deadLetterOnly, h.notify])).toEqual([[false, false]]);
    expect((await pool.query(`SELECT error_message FROM notes WHERE id = 'n1'`)).rows[0].error_message).toBe('The first failure.');
    expect(mirrored.map((m) => m.errorMessage)).toEqual(['The first failure.']);
  });

  it("Postgres can't be asked: the dead letter is still tried", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_last_outage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated outage'; END $$;
      CREATE TRIGGER test_last_outage BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION test_last_outage();`);
    try {
      const t = transcoder();
      expect(await t.run(kickoff)).toEqual({ failed: false });
      expect(t.hooks.map((h) => h.deadLetterOnly)).toEqual([true]);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS test_last_outage ON notes; DROP FUNCTION IF EXISTS test_last_outage();`);
    }
  });

  it('on the ledger: refunded with the failure', async () => {
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('u', 'ws', 'n1', 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', 'n1:ingest')`,
    );
    await transcoder().run(kickoff);
    expect((await pool.query(`SELECT reason FROM usage_ledger WHERE note_id = 'n1' AND entry_type = 'reversal'`)).rows)
      .toEqual([{ reason: 'refund:transcode_failed' }]);
  });

  it("a poll task's last attempt fails its chunk with the note, and its dead letter names the chunk", async () => {
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    const { rows: [c] } = await pool.query(
      `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status, stt_operation_id)
         VALUES ('n1', 0, 0, 600, 'chunks/n1', 'pending', 'operations/1') RETURNING id`,
    );
    const t = transcoder();
    expect(await t.run({ kind: 'stt-poll', jobId: 'job-7', chunkId: c.id, noteId: 'n1', workspaceId: 'ws', poll: 7 })).toEqual({ failed: true });
    expect((await pool.query('SELECT status FROM audio_chunks WHERE id = $1', [c.id])).rows[0].status).toBe('error');
    expect(await status()).toBe('error');
    expect(t.hooks[0].payload).toMatchObject({ kind: 'stt-poll', chunkId: c.id, jobId: 'job-7', poll: 7 });
  });

  it('a malformed chunk id is left out, and the note still fails', async () => {
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    const t = transcoder();
    expect(await t.run({ kind: 'stt-poll', chunkId: 'not-a-uuid', noteId: 'n1', workspaceId: 'ws' })).toEqual({ failed: true });
    expect(await status()).toBe('error');
  });

  it('a note that is gone: nothing to fail, no hooks', async () => {
    const t = transcoder();
    expect(await t.run({ ...kickoff, noteId: 'gone' })).toEqual({ failed: false });
    expect(t.hooks).toEqual([]);
    expect(warns).toContain('transcoder_last_attempt_hooks_skipped');
  });
});

describe('the summarizer, last attempt', () => {
  it('a note still summarizing: failed, then the hooks run once', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    const s = summarizerRun();
    expect(await s.run({ noteId: 'n1', workspaceId: 'ws' })).toEqual({ failed: true });
    expect(await status()).toBe('error');
    expect(s.hooks.map((h) => [h.deadLetterOnly, h.notify])).toEqual([[false, true]]);
  });

  it('a note already failed: the refund (a no-op if made), no second notice', async () => {
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
    const s = summarizerRun();
    expect(await s.run({ noteId: 'n1', workspaceId: 'ws' })).toEqual({ failed: false });
    expect(s.hooks.map((h) => [h.deadLetterOnly, h.notify])).toEqual([[false, false]]);
  });

  it("a regeneration's failure: failed and told, but not refunded (the recording's charge stands)", async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 2 WHERE id = 'n1'`);
    const s = summarizerRun();
    expect(await s.run({ noteId: 'n1', workspaceId: 'ws', summaryGeneration: 2 })).toEqual({ failed: true });
    expect(s.hooks.map((h) => [h.deadLetterOnly, h.notify])).toEqual([[false, true]]);
  });

  it('on the ledger, through the real hooks: a pipeline summary failure is refunded, a regeneration failure is not', async () => {
    for (const spec of ['@algominutes/db/usage-repo.ts', '@algominutes/db/dead-letter-repo.ts']) {
      const path = require.resolve(spec);
      require.cache[path] = { id: path, filename: path, loaded: true, exports: repo } as never;
    }
    const realHooks = require('../../services/summarizer/src/terminal-hooks.js');
    const ledger = async () => (await pool.query(
      `SELECT entry_type, minutes::float8 AS m FROM usage_ledger WHERE note_id = 'n1' ORDER BY id`,
    )).rows.map((r: any) => `${r.entry_type} ${r.m}`);
    const debit = (key: string) => pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         VALUES ('u', 'ws', 'n1', 'debit', 30, to_char(NOW(), 'YYYY-MM'), 'ingest', $1)`, [key],
    );
    const last = (body: any) => summarizerLast.onLastAttempt({
      body, headers, err: new Error('boom'), markNoteFailed: summarizer.markNoteFailed, pool: summarizer.pool, log, traceId: 't',
      terminalHooks: realHooks,
    });

    await debit('n1:ingest');
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 2 WHERE id = 'n1'`);
    await last({ noteId: 'n1', workspaceId: 'ws', summaryGeneration: 2 });
    expect(await ledger()).toEqual(['debit 30']);

    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    await last({ noteId: 'n1', workspaceId: 'ws' });
    expect(await ledger()).toEqual(['debit 30', 'reversal -30']);
  });

  it('a note that is ready anyway (the attempt threw after its summary committed): the dead letter only', async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    const s = summarizerRun();
    expect(await s.run({ noteId: 'n1', workspaceId: 'ws' })).toEqual({ failed: false });
    expect(await status()).toBe('ready');
    expect(s.hooks.map((h) => h.deadLetterOnly)).toEqual([true]);
    expect(warns).toContain('summarizer_last_attempt_dead_letter_only');
  });
});
