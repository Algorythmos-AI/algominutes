import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, deleteAccountData, createUploadSession, AccountDeletedError } from '@algominutes/db';
// @ts-expect-error: plain ESM route module, no type declarations
import { deleteAccountRoute } from '../../services/api/src/routes/delete-account.js';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// POST /v1/account/delete: Postgres first (with a tombstone), then each note's
// doc and audio, the account's own docs and storage, and Auth last. 200 only
// when everything is gone. Every step is idempotent, so a retry finishes a
// partial deletion.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice'); // not the personal id: a retry must still find it
  await seedWorkspace('ws-b', 'bob', ['alice']); // alice is also a member of bob's workspace
  await seedNote('a1', 'ws-a', 'alice');
  await seedNote('a2', 'ws-a', 'alice');
  await seedNote('a-in-b', 'ws-b', 'alice'); // alice's note in bob's workspace
  await seedNote('b1', 'ws-b', 'bob');
  await pool.query(`UPDATE notes SET storage_path = 'recordings/' || workspace_id || '/' || id || '.m4a'`);
  await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('a1', 0, 1, 'alice said'), ('b1', 0, 1, 'bob said')`);
  await pool.query(`INSERT INTO dead_letter (queue, note_id, workspace_id) VALUES ('transcode', 'a1', 'ws-a'), ('transcode', 'b1', 'ws-b')`);
  await pool.query(`INSERT INTO support_requests (uid, kind, message) VALUES ('alice', 'contact', 'my words'), ('bob', 'contact', 'his words')`);
  await pool.query(`INSERT INTO analytics_events (uid, event, props) VALUES ('alice', 'paywall_viewed', '{}'), ('bob', 'paywall_viewed', '{}')`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('deleteAccountData (Postgres, first)', () => {
  it("deletes the account and everything it owns, leaves others' data, queues every note's purge, and leaves a tombstone", async () => {
    const r = await deleteAccountData({ uid: 'alice', traceId: 't1' }, quietLog);
    expect(r).toEqual({ deleted: true, workspaceIds: ['ws-a'], notesQueued: 3, membershipsDeleted: 2 });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0);
    expect(await count(`SELECT 1 FROM workspaces WHERE id = 'ws-a'`)).toBe(0);
    expect(await count(`SELECT 1 FROM notes WHERE id IN ('a1', 'a2', 'a-in-b')`)).toBe(0);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'a1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM workspace_members WHERE uid = 'alice'`)).toBe(0);
    // Rows whose foreign keys would only NULL the uid (keeping the content) go too.
    expect(await count(`SELECT 1 FROM dead_letter WHERE note_id = 'a1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM support_requests WHERE message = 'my words'`)).toBe(0);
    expect(await count(`SELECT 1 FROM analytics_events WHERE uid IS NULL OR uid = 'alice'`)).toBe(0);
    // Bob's data is untouched.
    expect(await count(`SELECT 1 FROM notes WHERE id = 'b1'`)).toBe(1);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'b1'`)).toBe(1);
    expect(await count(`SELECT 1 FROM dead_letter WHERE note_id = 'b1'`)).toBe(1);
    expect(await count(`SELECT 1 FROM support_requests WHERE uid = 'bob'`)).toBe(1);
    // Sorted in JS: SQL ORDER BY depends on the database collation.
    expect((await pool.query(`SELECT note_id FROM storage_purges WHERE uid = 'alice'`)).rows.map((x) => x.note_id).sort())
      .toEqual(['a-in-b', 'a1', 'a2'].sort());
    expect((await pool.query(`SELECT workspace_ids FROM account_deletions WHERE uid = 'alice'`)).rows[0].workspace_ids).toEqual(['ws-a']);
  });

  it('a retry is a no-op that still knows the owned workspaces (from the tombstone)', async () => {
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect(await deleteAccountData({ uid: 'alice' }, quietLog))
      .toEqual({ deleted: false, workspaceIds: ['ws-a'], notesQueued: 0, membershipsDeleted: 0 });
  });

  // A deleted account's ID token can still verify for up to an hour. Its first
  // write must not quietly re-create the account.
  it('the tombstone stops the account from being re-created', async () => {
    await deleteAccountData({ uid: 'alice' }, quietLog);
    await expect(createUploadSession({
      uid: 'alice', workspaceId: 'workspace_alice', noteId: 'n9', storagePath: 'recordings/workspace_alice/n9.m4a',
      sessionUri: 'https://storage.googleapis.com/x', totalBytes: 1, expiresAt: new Date(Date.now() + 86_400_000),
    }, quietLog)).rejects.toBeInstanceOf(AccountDeletedError);
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0);
  });
});

// A stateful fake of the Firestore surface the path uses: docs by path,
// subcollections by prefix, recursiveDelete, and the analytics query.
function fakes({ firestoreFails = false, authFails = false, storageFailsOn = '' } = {}) {
  const docs = new Map<string, Record<string, unknown>>([
    ['workspaces/ws-a', { ownerId: 'alice' }],
    ['workspaces/ws-a/notes/a1', {}], ['workspaces/ws-a/notes/a2', {}],
    ['workspaces/ws-a/notes/never-processed', {}], // a client-created note doc with no Postgres row
    ['workspaces/ws-b/notes/a-in-b', {}],
    ['workspaces/workspace_alice', { ownerId: 'alice' }],
    ['rateLimits/alice', {}],
    ['analytics/e1', { workspaceId: 'ws-a' }], ['analytics/e2', { workspaceId: 'ws-b' }],
    ['workspaces/ws-b', { ownerId: 'bob' }], ['workspaces/ws-b/notes/b1', {}],
  ]);
  const objects = new Set([
    'recordings/ws-a/a1.m4a', 'recordings/ws-a/a2.m4a', 'recordings/ws-b/a-in-b.m4a',
    'recordings/ws-a/orphan-upload.m4a', // an upload that never became a note
    'recordings/ws-b/b1.m4a', 'recordings/ws-a0/x.m4a', // someone else's
  ]);
  const order: string[] = [];
  const state = { firestoreFails, authFails, storageFailsOn };
  const guard = () => { if (state.firestoreFails) throw new Error('firestore unavailable'); };
  const ref = (p: string) => ({
    path: p,
    delete: async () => { if (!p.includes('/notes/')) guard(); docs.delete(p); order.push('firestore'); },
  });
  const firestore = {
    doc: ref,
    recursiveDelete: async (r: { path: string }) => {
      guard();
      for (const k of [...docs.keys()]) if (k === r.path || k.startsWith(`${r.path}/`)) docs.delete(k);
      order.push('firestore');
    },
    collection: (c: string) => ({
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...docs.entries()].filter(([k, v]) => k.startsWith(`${c}/`) && v[field] === value).map(([k]) => ({ ref: ref(k) })),
        }),
      }),
    }),
  };
  const file = (name: string) => ({
    name,
    delete: async () => { if (name === state.storageFailsOn) throw new Error('storage 503'); objects.delete(name); },
  });
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
  return { deps: { auth, firestore, bucket }, docs, objects, order, state };
}
const BOBS_DOCS = ['analytics/e2', 'workspaces/ws-b', 'workspaces/ws-b/notes/b1'];
const BOBS_OBJECTS = ['recordings/ws-a0/x.m4a', 'recordings/ws-b/b1.m4a'];

async function call(deps: unknown, token = 'good') {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, child: () => log };
  await deleteAccountRoute({ method: 'POST', headers: { authorization: `Bearer ${token}` }, traceId: 't', log }, res, deps);
  return out;
}

describe('POST /v1/account/delete', () => {
  it('deletes Postgres, every doc (subcollections too) and object of the account, then Auth, and answers 200', async () => {
    const f = fakes();
    const out = await call(f.deps);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, summary: expect.objectContaining({ notesDeleted: 3, workspacesAffected: 1, authDeleted: true, firestoreErrors: 0 }) });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0);
    expect([...f.docs.keys()].sort()).toEqual(BOBS_DOCS);
    expect([...f.objects].sort()).toEqual(BOBS_OBJECTS);
    expect(await count(`SELECT 1 FROM storage_purges WHERE uid = 'alice'`)).toBe(0);
    expect(await count(`SELECT 1 FROM account_deletions WHERE uid = 'alice' AND completed_at IS NOT NULL`)).toBe(1);
    expect(f.order.at(-1)).toBe('auth'); // Auth last
  });

  it('a Postgres failure answers 500 and touches nothing else (Auth intact, so the user can retry)', async () => {
    const f = fakes();
    const out = await call({ ...f.deps, deleteAccountData: async () => { throw new Error('pg down'); } });
    expect(out.status).toBe(500);
    expect(f.order).toEqual([]);
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(1);
  });

  it('a Firestore failure answers 500 before Auth; the retry cleans even the non-personal workspace', async () => {
    const f = fakes({ firestoreFails: true });
    expect((await call(f.deps)).status).toBe(500);
    expect(f.order).not.toContain('auth');
    expect(await count(`SELECT 1 FROM users WHERE uid = 'alice'`)).toBe(0); // Postgres already gone
    f.state.firestoreFails = false;
    const retry = await call(f.deps);
    expect(retry.status).toBe(200);
    expect([...f.docs.keys()].sort()).toEqual(BOBS_DOCS);
    expect([...f.objects].sort()).toEqual(BOBS_OBJECTS);
    expect(f.order.at(-1)).toBe('auth');
  });

  // Nothing else retries a purge yet (the PR-15 sweeper), so a 200 must mean
  // everything is gone: a storage failure keeps Auth, for the client's retry.
  it('a storage failure answers 500 before Auth; the retry finishes', async () => {
    const f = fakes({ storageFailsOn: 'recordings/ws-a/a1.m4a' });
    expect((await call(f.deps)).status).toBe(500);
    expect(f.order).not.toContain('auth');
    expect(await count(`SELECT 1 FROM storage_purges WHERE uid = 'alice'`)).toBe(1);
    f.state.storageFailsOn = '';
    expect((await call(f.deps)).status).toBe(200);
    expect([...f.objects].sort()).toEqual(BOBS_OBJECTS);
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
