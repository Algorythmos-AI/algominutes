import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool, markQueued } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, quietLog } from './helpers';

// RELEASE.md rev 11, L3 (H2a). A note's second run (a Try again after an error, or the sweep's re-queue of a
// stale note) re-transcribes it from scratch: markQueued deletes the old audio_chunks, and the transcoder
// writes new chunks with new ids. The old run's transcript_lines survived with chunk_id NULL (ON DELETE SET
// NULL), and the partial unique index (chunk_id, idx) never matched them, so the note ended up with both runs'
// lines, interleaved by time. The summary and the embeddings were then built from the doubled text.
const require = createRequire(import.meta.url);
const { insertTranscriptLines } = require('@algominutes/db/pipeline-repo.cjs');

const docs = new Map<string, Record<string, unknown>>();
const fs = {
  doc: (path: string) => ({
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
  }),
} as never;

const queue = (noteId = 'n1', workspaceId = 'ws-a', authorUid = 'alice') => markQueued(fs, {
  noteId, workspaceId, authorUid, sourceType: 'recording', storagePath: `recordings/${workspaceId}/${noteId}.aac`,
}, quietLog);

/** What one chunked run writes: a chunk row and its lines. */
async function transcribe(noteId: string, texts: string[]) {
  const { rows: [chunk] } = await pool.query(
    `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status)
       VALUES ($1, 0, 0, 600, 'chunks/x.flac', 'done') RETURNING id`,
    [noteId],
  );
  const client = await pool.connect();
  try {
    await insertTranscriptLines(client, {
      noteId, chunkId: chunk.id,
      lines: texts.map((text, i) => ({ text, startMs: i * 1000, endMs: i * 1000 + 900, confidence: 0.9 })),
    });
  } finally {
    client.release();
  }
}
const lines = async (noteId = 'n1') =>
  (await pool.query(`SELECT text FROM transcript_lines WHERE note_id = $1 ORDER BY start_ms, id`, [noteId])).rows.map((r: any) => r.text);

beforeEach(async () => {
  await resetDb();
  docs.clear();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  await seedUser('bob');
  await seedWorkspace('ws-b', 'bob');
  docs.set('workspaces/ws-a/notes/n1', { authorId: 'alice', status: 'uploading' });
  docs.set('workspaces/ws-b/notes/n2', { authorId: 'bob', status: 'uploading' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe("a note's second run", () => {
  it("replaces the first run's transcript instead of adding to it", async () => {
    await queue();
    await transcribe('n1', ['hello', 'world']);
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);

    await queue();
    expect(await lines()).toEqual([]);
    await transcribe('n1', ['hello', 'world']);
    expect(await lines()).toEqual(['hello', 'world']);
  });

  it("leaves another workspace's note alone", async () => {
    await queue('n2', 'ws-b', 'bob');
    await transcribe('n2', ['bob speaks']);
    await queue();
    await queue();
    expect(await lines('n2')).toEqual(['bob speaks']);
  });
});
