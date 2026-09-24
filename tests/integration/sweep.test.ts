import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// The db-job sweeper (JOB_NAME=sweep), on real Postgres with Firebase faked.
const require = createRequire(import.meta.url);
const sweep = require('../../services/db-job/src/handlers/sweep.js');
const noteTerminal = require('@algominutes/ai/note-terminal.cjs');
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
});
