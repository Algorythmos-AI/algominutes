import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, markQueued, deleteNote } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// R1: a note deleted while its kickoff is in flight must stay deleted. The
// route reads the note doc, then spends a while on the size probe, rate limits
// and the trial before markQueued runs. A deletion in that window used to be
// undone: markQueued's INSERT re-created the Postgres row, its merge-set
// re-created the doc, and a job was queued.
const docs = new Map<string, Record<string, unknown>>();
let gate: Promise<void> | null = null;
function docRef(path: string) {
  return {
    path,
    async get() {
      if (gate) await gate; // lets a test hold markQueued inside its transaction
      const d = docs.get(path);
      return { exists: d !== undefined, data: () => d };
    },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() { docs.delete(path); },
  };
}
const fs = { doc: docRef } as never;
const DOC = 'workspaces/ws-a/notes/n1';
const input = {
  noteId: 'n1', workspaceId: 'ws-a', authorUid: 'alice', sourceType: 'recording',
  storagePath: 'recordings/ws-a/n1.m4a', meter: { minutes: 5, idempotencyKey: 'n1:ingest' },
};

beforeEach(async () => {
  await resetDb();
  docs.clear();
  gate = null;
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  docs.set(DOC, { authorId: 'alice', status: 'uploading' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('a kickoff racing the deletion of its note (R1)', () => {
  it('deleted before the kickoff transaction (purge still pending): refused, nothing re-created', async () => {
    await seedNote('n1', 'ws-a', 'alice');
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    docs.set(DOC, { authorId: 'alice' }); // the route read the doc before the deletion removed it
    expect(await markQueued(fs, input, quietLog)).toEqual({ queued: false, status: null, deleted: true });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM usage_ledger`)).toBe(0);
  });

  it('deleted and fully purged (no purge row left): the missing doc refuses it', async () => {
    await seedNote('n1', 'ws-a', 'alice');
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    // A completed purge leaves no purge row and no doc.
    await pool.query('DELETE FROM storage_purges');
    expect(docs.has(DOC)).toBe(false);
    expect(await markQueued(fs, input, quietLog)).toEqual({ queued: false, status: null, deleted: true });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM usage_ledger`)).toBe(0);
  });

  it('deleted and fully purged, but a stale client wrote the doc again: the tombstone refuses it', async () => {
    await seedNote('n1', 'ws-a', 'alice');
    await deleteNote(fs, { noteId: 'n1', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    await pool.query('DELETE FROM storage_purges');
    docs.set(DOC, { authorId: 'alice', status: 'queued' }); // e.g. the web client's setDoc merge (BLOCKERS R2)
    expect(await markQueued(fs, input, quietLog)).toEqual({ queued: false, status: null, deleted: true });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM usage_ledger`)).toBe(0);
  });

  const goneAtMirror = (onUpdate: () => Promise<void> = async () => {}) => ({
    doc: (path: string) => ({
      ...docRef(path),
      update: async () => { await onUpdate(); throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 }); },
    }),
  }) as never;

  it('deleted right after the commit (the row went too): reported deleted, and the doc is not re-created', async () => {
    const deletedMeanwhile = goneAtMirror(async () => { await pool.query(`DELETE FROM notes WHERE id = 'n1'`); });
    expect(await markQueued(deletedMeanwhile, input, quietLog)).toEqual({ queued: false, status: null, deleted: true });
  });

  it('the doc gone but the row live (a legacy client deleted the doc): it throws, so the route fails the note', async () => {
    await expect(markQueued(goneAtMirror(), input, quietLog)).rejects.toMatchObject({ code: 5 });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1'`)).toBe(1);
  });

  it('a deletion that arrives while the kickoff transaction is open waits, then deletes what it wrote', async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const kickoff = markQueued(fs, input, quietLog); // holds the note lock, blocked in its doc read
    await new Promise((r) => setTimeout(r, 100));
    const deletion = deleteNote(fs, { noteId: 'n1', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    await new Promise((r) => setTimeout(r, 200));
    gate = null;
    release();
    const [queued, deleted] = await Promise.all([kickoff, deletion]);
    expect(deleted).toMatchObject({ allowed: true, deleted: true });
    // Whichever way the mirror write raced the doc delete, the note is gone.
    expect(queued.queued === true || queued.deleted === true).toBe(true);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1'`)).toBe(0);
    expect(docs.has(DOC)).toBe(false);
  });
});
