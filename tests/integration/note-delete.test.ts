import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getPool, deleteNote, getStoragePurge, listPendingStoragePurges, runStoragePurge,
} from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// POST /v1/notes/delete (notes-repo deleteNote). Deleting a note used to depend
// on the functions/ trigger onNoteDeleted, which the new pipeline never
// deploys, so a deleted note stayed in Postgres (and searchable) and its audio
// stayed in the bucket.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob');
  await seedNote('note-a', 'ws-a', 'alice');
  await seedNote('note-b', 'ws-b', 'bob');
  await pool.query(`UPDATE notes SET storage_path = 'recordings/' || workspace_id || '/' || id || '.m4a'`);
  for (const [note, ws] of [['note-a', 'ws-a'], ['note-b', 'ws-b']]) {
    await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ($1, 0, 1000, 'hello')`, [note]);
    await pool.query(`INSERT INTO summaries (note_id, gist) VALUES ($1, 'gist')`, [note]);
    await pool.query(
      `INSERT INTO embeddings (note_id, workspace_id, chunk_text, embedding, model)
         VALUES ($1, $2, 'hello', array_fill(0.1::real, ARRAY[768])::vector, 'test')`,
      [note, ws],
    );
  }
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

function fsStub({ failDelete = false } = {}) {
  const deletes: string[] = [];
  const fs = {
    doc: (path: string) => ({
      delete: async () => {
        if (failDelete) throw new Error('firestore unavailable');
        deletes.push(path);
      },
    }),
  } as never;
  return { fs, deletes };
}
const rowsFor = async (note: string) => ({
  notes: await count('SELECT 1 FROM notes WHERE id = $1', [note]),
  transcript: await count('SELECT 1 FROM transcript_lines WHERE note_id = $1', [note]),
  summaries: await count('SELECT 1 FROM summaries WHERE note_id = $1', [note]),
  embeddings: await count('SELECT 1 FROM embeddings WHERE note_id = $1', [note]),
});
const ALL = { notes: 1, transcript: 1, summaries: 1, embeddings: 1 };
const NONE = { notes: 0, transcript: 0, summaries: 0, embeddings: 0 };

describe('deleteNote (the single deletion path)', () => {
  it('deletes the note and everything derived from it, mirrors the delete, and queues its audio', async () => {
    const { fs, deletes } = fsStub();
    const r = await deleteNote(fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'alice', traceId: 't-1' }, quietLog);
    expect(r).toEqual({ allowed: true, deleted: true, purgeId: expect.any(Number) });
    expect(await rowsFor('note-a')).toEqual(NONE); // nothing left for search/chat to return
    expect(deletes).toEqual(['workspaces/ws-a/notes/note-a']);
    const purge = await getStoragePurge((r as { purgeId: number }).purgeId);
    expect(purge).toMatchObject({
      noteId: 'note-a', workspaceId: 'ws-a', storagePath: 'recordings/ws-a/note-a.m4a', includeScratch: true, traceId: 't-1',
    });
    expect(await rowsFor('note-b')).toEqual(ALL);
  });

  it("refuses a caller who isn't a member of the workspace, and touches nothing", async () => {
    const { fs, deletes } = fsStub();
    expect(await deleteNote(fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'bob' }, quietLog)).toEqual({ allowed: false });
    expect(await rowsFor('note-a')).toEqual(ALL);
    expect(deletes).toEqual([]);
    expect(await count('SELECT 1 FROM storage_purges')).toBe(0);
  });

  // Postgres note ids are global. Naming another tenant's note under your own
  // workspace must not delete it, and must not purge its transcoder scratch
  // (which is keyed by note id alone).
  it("can't reach another workspace's note through your own workspace id", async () => {
    const { fs } = fsStub();
    const r = await deleteNote(fs, { noteId: 'note-b', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    expect(r).toMatchObject({ allowed: true, deleted: false });
    expect(await rowsFor('note-b')).toEqual(ALL);
    expect(await getStoragePurge((r as { purgeId: number }).purgeId)).toMatchObject({
      noteId: 'note-b', workspaceId: 'ws-a', storagePath: null, includeScratch: false,
    });
  });

  it('a retry after a failed Firestore delete finishes the job', async () => {
    const failing = fsStub({ failDelete: true });
    await expect(
      deleteNote(failing.fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'alice' }, quietLog),
    ).rejects.toThrow(/firestore unavailable/);
    expect(await rowsFor('note-a')).toEqual(NONE); // Postgres committed first
    expect(await count('SELECT 1 FROM storage_purges')).toBe(1); // and the purge with it

    const { fs, deletes } = fsStub();
    const retry = await deleteNote(fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    expect(retry).toMatchObject({ allowed: true, deleted: false });
    expect(deletes).toEqual(['workspaces/ws-a/notes/note-a']);
    // The id now exists nowhere, so the retry may purge the scratch too.
    expect(await getStoragePurge((retry as { purgeId: number }).purgeId)).toMatchObject({ includeScratch: true });
  });
});

function fakeBucket(names: string[], { failOn }: { failOn?: string } = {}) {
  const present = new Set(names);
  return {
    present,
    getFiles: async ({ prefix }: { prefix: string }) => [[...present].filter((n) => n.startsWith(prefix)).map((name) => ({ name }))],
    file: (name: string) => ({
      delete: async () => {
        if (name === failOn) throw new Error('storage 503');
        present.delete(name);
      },
    }),
  };
}

describe('runStoragePurge', () => {
  const errors: unknown[] = [];
  const log = { info: () => {}, error: (o: unknown) => void errors.push(o) };

  it("deletes exactly the note's objects, then the purge row", async () => {
    const { fs } = fsStub();
    const r = await deleteNote(fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'alice' }, quietLog);
    const bucket = fakeBucket([
      'recordings/ws-a/note-a.m4a', 'transcoder/note-a/chunk-000.flac',
      'recordings/ws-a/note-ab.m4a', // a different note whose id shares the prefix
      'recordings/ws-b/note-b.m4a',
    ]);
    const purge = (await getStoragePurge((r as { purgeId: number }).purgeId))!;
    expect(await runStoragePurge(bucket, purge, log)).toBe(true);
    expect([...bucket.present].sort()).toEqual(['recordings/ws-a/note-ab.m4a', 'recordings/ws-b/note-b.m4a']);
    expect(await count('SELECT 1 FROM storage_purges')).toBe(0);
  });

  it('keeps a failed purge queued, with the attempt and error recorded (and logged)', async () => {
    const { fs } = fsStub();
    const r = await deleteNote(fs, { noteId: 'note-a', workspaceId: 'ws-a', uid: 'alice', traceId: 't-2' }, quietLog);
    const bucket = fakeBucket(['recordings/ws-a/note-a.m4a'], { failOn: 'recordings/ws-a/note-a.m4a' });
    const purge = (await getStoragePurge((r as { purgeId: number }).purgeId))!;
    expect(await runStoragePurge(bucket, purge, log)).toBe(false);
    expect(await listPendingStoragePurges()).toEqual([
      expect.objectContaining({ noteId: 'note-a', attempts: 1, lastError: 'storage 503' }),
    ]);
    // Logged under the deleting request's traceId, so a sweeper retry still traces to it.
    expect(errors).toContainEqual(expect.objectContaining({ traceId: 't-2', noteId: 'note-a', workspaceId: 'ws-a', attempts: 1 }));
  });
});
