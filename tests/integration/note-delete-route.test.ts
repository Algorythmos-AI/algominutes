import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// POST /v1/notes/delete, driven for real against Postgres, with Firestore and
// Cloud Storage faked at the firebase-admin boundary.
const fsDeletes: string[] = [];
const bucketState = { present: new Set<string>(), failOn: '' };
vi.mock('firebase-admin/firestore', async (orig) => ({
  ...(await orig<typeof import('firebase-admin/firestore')>()),
  getFirestore: () => ({ doc: (p: string) => ({ delete: async () => void fsDeletes.push(p) }) }),
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      getFiles: async ({ prefix }: { prefix: string }) =>
        [[...bucketState.present].filter((n) => n.startsWith(prefix)).map((name) => ({ name }))],
      file: (name: string) => ({
        delete: async () => {
          if (name === bucketState.failOn) throw new Error('storage 503');
          bucketState.present.delete(name);
        },
      }),
    }),
  }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { deleteNoteRoute } = await import('../../services/api/src/routes/delete-note.js');

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedNote('note-a', 'ws-a', 'alice');
  await pool.query(`UPDATE notes SET storage_path = 'recordings/ws-a/note-a.m4a'`);
  fsDeletes.length = 0;
  bucketState.present = new Set(['recordings/ws-a/note-a.m4a', 'recordings/ws-a/note-ab.m4a']);
  bucketState.failOn = '';
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function call(uid: string, body: unknown) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
  const noop = () => {};
  const log = { warn: noop, info: noop, error: noop, child: () => log };
  await deleteNoteRoute({ uid, traceId: 'trace-del', body, log }, res);
  return out;
}

describe('POST /v1/notes/delete', () => {
  it('deletes the note, its Firestore doc and its audio, and says so', async () => {
    expect(await call('alice', { noteId: 'note-a', workspaceId: 'ws-a' }))
      .toEqual({ status: 200, body: { ok: true, noteId: 'note-a', deleted: true } });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'note-a'`)).toBe(0);
    expect(new Set(fsDeletes)).toEqual(new Set(['workspaces/ws-a/notes/note-a']));
    expect([...bucketState.present]).toEqual(['recordings/ws-a/note-ab.m4a']);
    expect(await count('SELECT 1 FROM storage_purges')).toBe(0);
  });

  it('is safe to retry: a second delete answers 200 with deleted: false', async () => {
    await call('alice', { noteId: 'note-a', workspaceId: 'ws-a' });
    expect(await call('alice', { noteId: 'note-a', workspaceId: 'ws-a' }))
      .toEqual({ status: 200, body: { ok: true, noteId: 'note-a', deleted: false } });
  });

  it('answers 404 to a non-member, and touches nothing', async () => {
    expect((await call('bob', { noteId: 'note-a', workspaceId: 'ws-a' })).status).toBe(404);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'note-a'`)).toBe(1);
    expect(fsDeletes).toEqual([]);
  });

  it('refuses a malformed body', async () => {
    for (const bad of [{}, { noteId: 'note-a' }, { noteId: '../x', workspaceId: 'ws-a' }, { noteId: 1, workspaceId: 'ws-a' }]) {
      expect((await call('alice', bad)).status).toBe(400);
    }
  });

  it("a storage failure doesn't fail the delete: the purge stays queued for a retry", async () => {
    bucketState.failOn = 'recordings/ws-a/note-a.m4a';
    expect((await call('alice', { noteId: 'note-a', workspaceId: 'ws-a' })).body).toEqual({ ok: true, noteId: 'note-a', deleted: true });
    expect(await count(`SELECT 1 FROM storage_purges WHERE note_id = 'note-a' AND attempts = 1`)).toBe(1);
  });
});
