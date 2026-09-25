import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// The db-job sweeper (JOB_NAME=sweep), on real Postgres with Firebase faked.
const require = createRequire(import.meta.url);
const sweep = require('../../services/db-job/src/handlers/sweep.js');
const noteTerminal = require('@algominutes/db/note-terminal.cjs');
const { getPool, deleteAccountData } = repo;

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function fakes({ storageFails = false } = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  const objects = new Set<string>();
  const updates: Array<{ path: string; data: any }> = [];
  const deletedUsers: string[] = [];
  const state = { storageFails };
  const ref = (p: string) => ({
    path: p,
    delete: async () => void docs.delete(p),
    update: async (data: any) => {
      if (!docs.has(p)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      updates.push({ path: p, data });
    },
  });
  const firestore = {
    doc: ref,
    recursiveDelete: async (r: { path: string }) => {
      for (const k of [...docs.keys()]) if (k === r.path || k.startsWith(`${r.path}/`)) docs.delete(k);
    },
    collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
  };
  const file = (name: string) => ({
    name,
    delete: async () => { if (state.storageFails) throw new Error('storage 503'); objects.delete(name); },
  });
  const bucket = { getFiles: async ({ prefix }: { prefix: string }) => [[...objects].filter((n) => n.startsWith(prefix)).map(file)] };
  const auth = { deleteUser: async (uid: string) => void deletedUsers.push(uid) };
  return { deps: { auth, firestore, bucket }, docs, objects, updates, deletedUsers, state };
}

const errors: Array<{ o: any; m: string }> = [];
const log = {
  info: () => {}, warn: () => {},
  error: (o: any, m: string) => void errors.push({ o, m }),
  child() { return log; },
};
const runSweep = (deps: unknown) => sweep.run({ log, env: {}, traceId: 't-sweep', deps, repo, noteTerminal });

beforeEach(async () => {
  await resetDb();
  errors.length = 0;
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('sweep', () => {
  it('uses the same in-flight stale window as the kickoff (IN_FLIGHT_STALE_MS)', () => {
    expect(sweep.IN_FLIGHT_STALE_MS).toBe(repo.IN_FLIGHT_STALE_MS);
    expect(sweep.STUCK_NOTE_MS).toBeGreaterThan(repo.IN_FLIGHT_STALE_MS);
  });

  it('retries pending purges past their grace; leaves fresh ones; flags stuck ones without running them', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO storage_purges (note_id, workspace_id, include_scratch, created_at, attempts) VALUES
         ('old', 'ws-a', TRUE, $1, 1), ('fresh', 'ws-a', TRUE, NOW(), 0), ('stuck', 'ws-a', TRUE, $1, 10)`,
      [ago(HOUR)],
    );
    for (const n of ['old', 'fresh', 'stuck']) { f.objects.add(`recordings/ws-a/${n}.m4a`); f.docs.set(`workspaces/ws-a/notes/${n}`, {}); }
    const counts = await runSweep(f.deps);
    expect(counts.storage_purges).toEqual({ done: 1, stuck: 1 });
    expect([...f.objects].sort()).toEqual(['recordings/ws-a/fresh.m4a', 'recordings/ws-a/stuck.m4a']);
    expect(await count(`SELECT 1 FROM storage_purges WHERE note_id = 'old'`)).toBe(0);
    expect(errors).toContainEqual(expect.objectContaining({ m: 'storage_purge_stuck', o: expect.objectContaining({ noteId: 'stuck' }) }));
  });

  it('a stuck purge is logged under its account and original trace', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO storage_purges (note_id, workspace_id, include_scratch, created_at, attempts, uid, trace_id)
         VALUES ('stuck2', 'ws-a', TRUE, $1, 10, 'alice', 'trace-orig')`,
      [ago(HOUR)],
    );
    await runSweep(f.deps);
    expect(errors).toContainEqual(expect.objectContaining({
      m: 'storage_purge_stuck', o: expect.objectContaining({ noteId: 'stuck2', userId: 'alice', traceId: 'trace-orig' }),
    }));
  });

  it('fails notes stuck in flight (Postgres, then the mirror), with a dead letter; leaves healthy and finished ones', async () => {
    const f = fakes();
    await seedNote('stuck', 'ws-a', 'alice');
    await seedNote('busy', 'ws-a', 'alice');
    await seedNote('done', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = $1 WHERE id = 'stuck'`, [ago(4 * HOUR)]);
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = $1 WHERE id = 'busy'`, [ago(HOUR)]);
    await pool.query(`UPDATE notes SET status = 'ready', updated_at = $1 WHERE id = 'done'`, [ago(10 * HOUR)]);
    f.docs.set('workspaces/ws-a/notes/stuck', {});
    const counts = await runSweep(f.deps);
    expect(counts.stuck_notes).toBe(1);
    const status = async (id: string) => (await pool.query('SELECT status FROM notes WHERE id = $1', [id])).rows[0].status;
    expect(await status('stuck')).toBe('error');
    expect(await status('busy')).toBe('transcribing');
    expect(await status('done')).toBe('ready');
    expect(f.updates).toEqual([{ path: 'workspaces/ws-a/notes/stuck', data: expect.objectContaining({ status: 'error' }) }]);
    expect(await count(`SELECT 1 FROM dead_letter WHERE queue = 'sweep' AND note_id = 'stuck'`)).toBe(1);
  });

  it('deletes expired upload sessions and keeps live ones', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO upload_sessions (uid, workspace_id, note_id, storage_path, session_uri, total_bytes, expires_at) VALUES
         ('alice', 'ws-a', 'n1', 'recordings/ws-a/n1.m4a', 'https://storage.googleapis.com/a', 1, $1),
         ('alice', 'ws-a', 'n2', 'recordings/ws-a/n2.m4a', 'https://storage.googleapis.com/b', 1, NOW() + INTERVAL '1 day')`,
      [ago(HOUR)],
    );
    expect((await runSweep(f.deps)).upload_sessions).toBe(1);
    expect(await count(`SELECT 1 FROM upload_sessions`)).toBe(1);
  });

  // A client that crashed, or gave up after a 500, leaves the deletion
  // half-done: Postgres gone, Auth alive. The sweeper finishes it.
  it('finishes an account deletion the client never completed, after its grace', async () => {
    const f = fakes({ storageFails: true });
    await seedNote('a1', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET storage_path = 'recordings/ws-a/a1.m4a' WHERE id = 'a1'`);
    f.objects.add('recordings/ws-a/a1.m4a');
    f.docs.set('workspaces/ws-a', {}); f.docs.set('workspaces/ws-a/notes/a1', {});
    await deleteAccountData({ uid: 'alice' }, quietLog);

    // Within the grace window the client's own retry goes first: untouched.
    expect((await runSweep(f.deps)).account_deletions).toBe(0);
    await pool.query(`UPDATE account_deletions SET requested_at = $1 WHERE uid = 'alice'`, [ago(HOUR)]);
    // Still failing: the step fails (visible), Auth is kept.
    await expect(runSweep(f.deps)).rejects.toThrow(/account_deletions/);
    expect(f.deletedUsers).toEqual([]);
    // Recovered: finished, Auth deleted, the tombstone completed.
    f.state.storageFails = false;
    expect((await runSweep(f.deps)).account_deletions).toBe(1);
    expect(f.deletedUsers).toEqual(['alice']);
    expect(f.objects.size).toBe(0);
    expect([...f.docs.keys()]).toEqual([]);
    expect(await count(`SELECT 1 FROM account_deletions WHERE uid = 'alice' AND completed_at IS NOT NULL`)).toBe(1);
  });

  it('prunes tombstones completed over 30 days ago, keeps recent and incomplete ones', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO account_deletions (uid, requested_at, completed_at) VALUES
         ('gone-long-ago', $1, $1), ('gone-recently', $2, $2), ('still-open', NOW(), NULL)`,
      [ago(31 * 24 * HOUR), ago(29 * 24 * HOUR)],
    );
    expect((await runSweep(f.deps)).tombstones).toBe(1);
    expect((await pool.query(`SELECT uid FROM account_deletions`)).rows.map((r) => r.uid).sort()).toEqual(['gone-recently', 'still-open']);
  });

  it('prunes deleted-note tombstones older than 30 days, keeps recent ones', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO deleted_notes (note_id, workspace_id, deleted_at) VALUES ('old', 'ws', $1), ('recent', 'ws', $2)`,
      [ago(31 * 24 * HOUR), ago(29 * 24 * HOUR)],
    );
    expect((await runSweep(f.deps)).note_tombstones).toBe(1);
    expect((await pool.query(`SELECT note_id FROM deleted_notes`)).rows.map((r) => r.note_id)).toEqual(['recent']);
  });

  it('prunes paid-work records (the spend cap reads 24 hours) older than 90 days, keeps recent ones', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO usage_events (event, audio_seconds, created_at) VALUES ('stt_call', 60, $1), ('stt_call', 60, $2)`,
      [ago(91 * 24 * HOUR), ago(89 * 24 * HOUR)],
    );
    expect((await runSweep(f.deps)).usage_events).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM usage_events`)).rows[0].n)).toBe(1);
  });

  it('a failing step is logged, the others still run, and the job fails visibly', async () => {
    const f = fakes();
    const broken = { ...repo, listStuckNotes: async () => { throw new Error('boom'); } };
    await pool.query(
      `INSERT INTO upload_sessions (uid, workspace_id, note_id, storage_path, session_uri, total_bytes, expires_at)
         VALUES ('alice', 'ws-a', 'n1', 'recordings/ws-a/n1.m4a', 'https://storage.googleapis.com/a', 1, $1)`,
      [ago(HOUR)],
    );
    await expect(sweep.run({ log, env: {}, traceId: 't', deps: f.deps, repo: broken, noteTerminal })).rejects.toThrow(/stuck_notes/);
    expect(await count(`SELECT 1 FROM upload_sessions`)).toBe(0); // a later step still ran
    expect(errors).toContainEqual(expect.objectContaining({ m: 'sweep_step_failed', o: expect.objectContaining({ step: 'stuck_notes' }) }));
  });

  // One account's failure (a throw, not just "incomplete") must not skip the rest.
  it("one abandoned deletion that throws doesn't stop the next one being finished", async () => {
    const f = fakes();
    await seedUser('bob');
    await deleteAccountData({ uid: 'alice' }, quietLog);
    await deleteAccountData({ uid: 'bob' }, quietLog);
    await pool.query(`UPDATE account_deletions SET requested_at = $1`, [ago(HOUR)]);
    const flaky = {
      ...repo,
      finishAccountDeletion: async (deps: any, d: any, l: any) => {
        if (d.uid === 'alice') throw new Error('listing failed');
        return repo.finishAccountDeletion(deps, d, l);
      },
    };
    await expect(sweep.run({ log, env: {}, traceId: 't', deps: f.deps, repo: flaky, noteTerminal })).rejects.toThrow(/account_deletions/);
    expect(f.deletedUsers).toEqual(['bob']);
    expect(errors).toContainEqual(expect.objectContaining({ m: 'sweep_account_deletion_failed' }));
  });

  // Found by the sweeper's dual-write audit: the note was listed as stuck, then
  // moved on (a chunk finished) before the sweeper reached it. The UPDATE
  // re-checks, so it is left alone, with no dead letter and no refund.
  it("doesn't fail, dead-letter or refund a note that moved on after it was listed", async () => {
    const f = fakes();
    await seedNote('moved', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = NOW() WHERE id = 'moved'`);
    f.docs.set('workspaces/ws-a/notes/moved', {});
    const staleListing = {
      ...repo,
      listStuckNotes: async () => [{ noteId: 'moved', workspaceId: 'ws-a', authorUid: 'alice', status: 'transcribing', updatedAt: new Date(Date.now() - 4 * HOUR) }],
    };
    const counts = await sweep.run({ log, env: {}, traceId: 't', deps: f.deps, repo: staleListing, noteTerminal });
    expect(counts.stuck_notes).toBe(0);
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'moved'`)).rows[0].status).toBe('transcribing');
    expect(f.updates).toEqual([]);
    expect(await count(`SELECT 1 FROM dead_letter WHERE note_id = 'moved'`)).toBe(0);
  });

  it('two sweeps never overlap (advisory lock)', async () => {
    const f = fakes();
    const holder = await pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('algominutes:sweep'))`);
      expect(await runSweep(f.deps)).toEqual({ skipped: 'already_running' });
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext('algominutes:sweep'))`);
      holder.release();
    }
    expect(await runSweep(f.deps)).not.toEqual({ skipped: 'already_running' });
  });

  it('stuck purges never crowd out newer ones', async () => {
    const f = fakes();
    await pool.query(
      `INSERT INTO storage_purges (note_id, workspace_id, include_scratch, created_at, attempts)
         SELECT 'stuck-' || g, 'ws-a', TRUE, $1, 10 FROM generate_series(1, 205) g`,
      [ago(2 * HOUR)],
    );
    await pool.query(`INSERT INTO storage_purges (note_id, workspace_id, include_scratch, created_at) VALUES ('newer', 'ws-a', TRUE, $1)`, [ago(HOUR)]);
    f.objects.add('recordings/ws-a/newer.m4a');
    const counts = await runSweep(f.deps);
    expect(counts.storage_purges.done).toBe(1);
    expect(f.objects.has('recordings/ws-a/newer.m4a')).toBe(false);
  });
});

describe('sweep: retention and trials', () => {
  const DAY = 24 * HOUR;
  it("deletes notes older than their author's retention choice, through deleteNote, and purges them", async () => {
    const f = fakes();
    await pool.query(`UPDATE users SET retention_days = 30 WHERE uid = 'alice'`);
    await seedUser('bob'); // keeps everything (retention_days NULL)
    await seedWorkspace('ws-b', 'bob');
    for (const [id, ws, author, age] of [['old', 'ws-a', 'alice', 40], ['recent', 'ws-a', 'alice', 10], ['bobs', 'ws-b', 'bob', 400]] as const) {
      await seedNote(id, ws, author);
      await pool.query('UPDATE notes SET created_at = $2, storage_path = $3 WHERE id = $1', [id, ago(age * DAY), `recordings/${ws}/${id}.m4a`]);
      f.objects.add(`recordings/${ws}/${id}.m4a`);
      f.docs.set(`workspaces/${ws}/notes/${id}`, {});
    }
    const counts = await runSweep(f.deps);
    expect(counts.retention).toBe(1);
    expect((await pool.query('SELECT id FROM notes ORDER BY id')).rows.map((r) => r.id)).toEqual(['bobs', 'recent']);
    expect([...f.objects].sort()).toEqual(['recordings/ws-a/recent.m4a', 'recordings/ws-b/bobs.m4a']);
    expect(f.docs.has('workspaces/ws-a/notes/old')).toBe(false);
    expect(await count(`SELECT 1 FROM storage_purges`)).toBe(0); // purged in the same run
    expect(errors).toEqual([]);
  });

  it('a failed purge stays queued for the storage_purges step; the note is still gone', async () => {
    const f = fakes({ storageFails: true });
    await pool.query(`UPDATE users SET retention_days = 7 WHERE uid = 'alice'`);
    await seedNote('old', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET created_at = $1, storage_path = 'recordings/ws-a/old.m4a' WHERE id = 'old'`, [ago(8 * DAY)]);
    f.objects.add('recordings/ws-a/old.m4a');
    await runSweep(f.deps);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'old'`)).toBe(0);
    expect(await count(`SELECT 1 FROM storage_purges WHERE note_id = 'old' AND attempts = 1`)).toBe(1);
  });

  it("flips elapsed trials to free_floor, and leaves live trials and paid periods alone", async () => {
    const f = fakes();
    await seedUser('bob');
    await seedUser('carol');
    await pool.query(
      `INSERT INTO subscriptions (uid, plan, status, entitlement_state, trial_started_at, trial_end, current_period_end) VALUES
         ('alice', 'free', 'trialing', 'trialing', NOW() - INTERVAL '8 days', NOW() - INTERVAL '1 day', NULL),
         ('bob',   'free', 'trialing', 'trialing', NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days', NULL),
         ('carol', 'pro',  'active',   'trialing', NOW() - INTERVAL '8 days', NOW() - INTERVAL '1 day', NOW() + INTERVAL '20 days')`,
    );
    const counts = await runSweep(f.deps);
    expect(counts.trials).toBe(1);
    const { rows } = await pool.query('SELECT uid, entitlement_state FROM subscriptions ORDER BY uid');
    expect(rows).toEqual([
      { uid: 'alice', entitlement_state: 'free_floor' },
      { uid: 'bob', entitlement_state: 'trialing' },
      { uid: 'carol', entitlement_state: 'trialing' },
    ]);
  });
});

describe('account deletion and a leftover note purge with upload sessions', () => {
  it("cancels the note purge's sessions through the deletion's own fetch", async () => {
    const f = fakes();
    const SESSION = 'https://storage.googleapis.com/upload/storage/v1/b/bkt/o?uploadType=resumable&upload_id=xyz';
    await seedNote('n-up', 'ws-a', 'alice');
    await pool.query(
      `INSERT INTO upload_sessions (uid, workspace_id, note_id, storage_path, session_uri, total_bytes, expires_at)
         VALUES ('alice', 'ws-a', 'n-up', 'recordings/ws-a/n-up.m4a', $1, 1, NOW() + INTERVAL '1 day')`,
      [SESSION],
    );
    // The note was deleted earlier; its purge never ran.
    await repo.deleteNote(f.deps.firestore as never, { noteId: 'n-up', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    const d = await deleteAccountData({ uid: 'alice' }, quietLog);
    const cancelled: string[] = [];
    const fetch = async (url: string) => { cancelled.push(url); return { status: 499 }; };
    const r = await repo.finishAccountDeletion({ ...f.deps, fetch } as never, { uid: 'alice', ...d }, log);
    expect(r.complete).toBe(true);
    expect(cancelled).toEqual([SESSION]);
    expect(await count('SELECT 1 FROM storage_purges')).toBe(0);
  });
});
