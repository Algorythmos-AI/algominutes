import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, deleteAccountData } from '@algominutes/db';
// @ts-expect-error: plain ESM route module, no type declarations
import { deleteAccountRoute } from '../../services/api/src/routes/delete-account.js';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// POST /v1/account/delete: Postgres first, then each note's doc and audio, the
// account's own docs and storage, and Auth last. 200 only when Postgres is gone.
// Every step is idempotent, so a retry finishes a partial deletion.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob', ['alice']); // alice is also a member of bob's workspace
  await seedNote('a1', 'ws-a', 'alice');
  await seedNote('a2', 'ws-a', 'alice');
  await seedNote('a-in-b', 'ws-b', 'alice'); // alice's note in bob's workspace
  await seedNote('b1', 'ws-b', 'bob');
  await pool.query(`UPDATE notes SET storage_path = 'recordings/' || workspace_id || '/' || id || '.m4a'`);
  await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('a1', 0, 1, 'alice said'), ('b1', 0, 1, 'bob said')`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('deleteAccountData (Postgres, first)', () => {
  it("deletes the account and everything it owns, leaves others' data, and queues every note's purge", async () => {
    const r = await deleteAccountData({ uid: 'alice', traceId: 't1' }, quietLog);
    expect(r).toEqual({ deleted: true, workspaceIds: ['ws-a'], notesQueued: 3, membershipsDeleted: 2 });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0);
    expect(await count(`SELECT 1 FROM workspaces WHERE id = 'ws-a'`)).toBe(0);
    expect(await count(`SELECT 1 FROM notes WHERE id IN ('a1', 'a2', 'a-in-b')`)).toBe(0);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'a1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM workspace_members WHERE uid = 'alice'`)).toBe(0);
    // Bob and his note are untouched.
    expect(await count(`SELECT 1 FROM notes WHERE id = 'b1'`)).toBe(1);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'b1'`)).toBe(1);
    // Sorted in JS: SQL ORDER BY depends on the database collation.
    expect((await pool.query(`SELECT note_id FROM storage_purges WHERE uid = 'alice'`)).rows.map((x) => x.note_id).sort())
      .toEqual(['a-in-b', 'a1', 'a2'].sort());
  });

  it('is a no-op on a retry (the account is already gone)', async () => {
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await deleteAccountData({ uid: 'alice' }, quietLog)).toEqual({ deleted: false, workspaceIds: [], notesQueued: 0, membershipsDeleted: 0 });
  });
});

function fakes({ firestoreFails = false, authFails = false } = {}) {
  const docDeletes: string[] = [];
  const objects = new Set([
    'recordings/ws-a/a1.m4a', 'recordings/ws-a/a2.m4a', 'recordings/ws-b/a-in-b.m4a',
    'recordings/ws-a/orphan-upload.m4a', // an upload that never became a note
    'recordings/ws-b/b1.m4a', 'recordings/ws-a0/x.m4a', // someone else's
  ]);
  const order: string[] = [];
  const state = { firestoreFails, authFails };
  const firestore = {
    doc: (p: string) => ({
      delete: async () => {
        if (state.firestoreFails && !p.includes('/notes/')) throw new Error('firestore unavailable');
        docDeletes.push(p);
        order.push('firestore');
      },
    }),
  };
  const file = (name: string) => ({ name, delete: async () => void objects.delete(name) });
  const bucket = {
    getFiles: async ({ prefix }: { prefix: string }) => [[...objects].filter((n) => n.startsWith(prefix)).map(file)],
    file,
  };
  const auth = {
    verifyIdToken: async (t: string) => { if (t !== 'good') throw new Error('bad token'); return { uid: 'alice' }; },
    deleteUser: async () => {
      if (state.authFails) throw Object.assign(new Error('auth down'), { code: 'auth/internal-error' });
      order.push('auth');
    },
  };
  return { deps: { auth, firestore, bucket }, docDeletes, objects, order, state };
}

async function call(deps: unknown, token = 'good') {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await deleteAccountRoute({ method: 'POST', headers: { authorization: `Bearer ${token}` }, traceId: 't', log }, res, deps);
  return out;
}

describe('POST /v1/account/delete', () => {
  it('deletes Postgres, every doc and object of the account, then Auth, and answers 200', async () => {
    const f = fakes();
    const out = await call(f.deps);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, summary: expect.objectContaining({ notesDeleted: 3, workspacesAffected: 1, authDeleted: true, firestoreErrors: 0 }) });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0);
    expect(new Set(f.docDeletes)).toEqual(new Set([
      'workspaces/ws-a/notes/a1', 'workspaces/ws-a/notes/a2', 'workspaces/ws-b/notes/a-in-b',
      'workspaces/ws-a', 'workspaces/workspace_alice', 'rateLimits/alice',
    ]));
    expect([...f.objects].sort()).toEqual(['recordings/ws-a0/x.m4a', 'recordings/ws-b/b1.m4a']);
    expect(await count(`SELECT 1 FROM storage_purges WHERE uid = 'alice'`)).toBe(0);
    expect(f.order.at(-1)).toBe('auth'); // Auth last
  });

  it('a Postgres failure answers 500 and touches nothing else (Auth intact, so the user can retry)', async () => {
    const f = fakes();
    const out = await call({ ...f.deps, deleteAccountData: async () => { throw new Error('pg down'); } });
    expect(out.status).toBe(500);
    expect(f.order).toEqual([]);
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(1);
  });

  it('a Firestore failure answers 500 before Auth; the retry finishes the job', async () => {
    const f = fakes({ firestoreFails: true });
    expect((await call(f.deps)).status).toBe(500);
    expect(f.order).not.toContain('auth');
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0); // Postgres already gone
    f.state.firestoreFails = false;
    const retry = await call(f.deps);
    expect(retry.status).toBe(200);
    expect(f.docDeletes).toEqual(expect.arrayContaining(['workspaces/workspace_alice', 'rateLimits/alice']));
    expect(f.order.at(-1)).toBe('auth');
  });

  it('an Auth failure answers 500; the retry answers 200', async () => {
    const f = fakes({ authFails: true });
    expect((await call(f.deps)).status).toBe(500);
    f.state.authFails = false;
    expect((await call(f.deps)).status).toBe(200);
  });

  it('refuses a missing or invalid token', async () => {
    const f = fakes();
    expect((await call(f.deps, 'forged')).status).toBe(401);
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(1);
  });
});
