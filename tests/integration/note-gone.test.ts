import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// Workers and a deleted (or mismatched) note, on real Postgres.
const require = createRequire(import.meta.url);
const transcoderDb = require('../../services/transcoder/src/db.js');
const { loadTranscriptForEmbedding } = require('@algominutes/db/embeddings-repo.cjs');
const { markNoteFailed } = require('@algominutes/db/note-terminal.cjs');

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob');
  await seedNote('note-a', 'ws-a', 'alice');
  await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('note-a', 0, 1000, 'alice only')`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('transcoder status write', () => {
  it("is scoped to the task's workspace, and a deleted note matches nothing (NOTE_NOT_FOUND)", async () => {
    const c = await pool.connect();
    try {
      await transcoderDb.upsertNoteStatus(c, { noteId: 'note-a', workspaceId: 'ws-a', status: 'transcribing' });
      await expect(transcoderDb.upsertNoteStatus(c, { noteId: 'note-a', workspaceId: 'ws-b', status: 'error' }))
        .rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
      expect((await pool.query(`SELECT status FROM notes WHERE id = 'note-a'`)).rows[0].status).toBe('transcribing');
      expect(await transcoderDb.noteExists(c, { noteId: 'note-a', workspaceId: 'ws-a' })).toBe(true);
      expect(await transcoderDb.noteExists(c, { noteId: 'note-a', workspaceId: 'ws-b' })).toBe(false);
      await pool.query(`DELETE FROM notes WHERE id = 'note-a'`);
      expect(await transcoderDb.noteExists(c, { noteId: 'note-a', workspaceId: 'ws-a' })).toBe(false);
      await expect(transcoderDb.upsertNoteStatus(c, { noteId: 'note-a', workspaceId: 'ws-a', status: 'ready' }))
        .rejects.toMatchObject({ code: 'NOTE_NOT_FOUND' });
    } finally {
      c.release();
    }
  });
});

describe('embedder transcript read', () => {
  // Embeddings are written under the task's workspace_id; reading by note id
  // alone would index one workspace's words into another's search.
  it("reads only a live note in the task's workspace", async () => {
    expect(await loadTranscriptForEmbedding(pool, { noteId: 'note-a', workspaceId: 'ws-a' }))
      .toEqual([expect.objectContaining({ text: 'alice only' })]);
    expect(await loadTranscriptForEmbedding(pool, { noteId: 'note-a', workspaceId: 'ws-b' })).toBeNull();
    await pool.query(`DELETE FROM notes WHERE id = 'note-a'`);
    expect(await loadTranscriptForEmbedding(pool, { noteId: 'note-a', workspaceId: 'ws-a' })).toBeNull();
  });
});

describe('note-terminal markNoteFailed', () => {
  // When its Postgres write errors it still mirrors the failure, and must
  // never re-create a deleted note's doc while doing so.
  it("doesn't re-create a deleted note's doc when Postgres errored", async () => {
    const brokenPool = { connect: async () => { throw new Error('connection refused'); } };
    const calls: string[] = [];
    const firestore = {
      doc: () => ({
        update: async () => { calls.push('update'); throw Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 }); },
        set: async () => { calls.push('set'); },
      }),
    };
    const warns: string[] = [];
    const log = { error: () => {}, warn: (_o: unknown, m: string) => void warns.push(m), info: () => {} };
    await markNoteFailed({ pool: brokenPool, firestore, noteId: 'note-x', workspaceId: 'ws-a', message: 'failed', log, event: 'test' });
    expect(calls).toEqual(['update']);
    expect(warns).toContain('test_note_gone');
  });

  it("Postgres marked the note failed but its doc is missing: an error, not 'note gone'", async () => {
    const firestore = {
      doc: () => ({ update: async () => { throw Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 }); } }),
    };
    const errors: string[] = [];
    const log = { error: (_o: unknown, m: string) => void errors.push(m), warn: () => {}, info: () => {} };
    await markNoteFailed({ pool, firestore, noteId: 'note-a', workspaceId: 'ws-a', message: 'failed', log, event: 'test' });
    expect(errors).toContain('test_mirror_doc_missing');
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'note-a'`)).rows[0].status).toBe('error');
  });
});
