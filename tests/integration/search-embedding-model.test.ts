import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// /v1/search and chat retrieval compare the query's vector only with rows
// embedded by the same model. Vectors from different models don't compare,
// and the text-embedding-004 → gemini-embedding-001 migration (due before
// 2027-04-01) re-embeds in place, so both kinds of row will coexist.
const require = createRequire(import.meta.url);
const { hybridSearch } = require('../../services/api/src/routes/search-and-chat.cjs');
const { EMBED_MODEL } = require('@algominutes/ai/models.cjs');
const readPool = require('@algominutes/ai/pg-query.cjs').pool();

const DIMS = 768;
const unit = (i: number) => Array.from({ length: DIMS }, (_, j) => (j === i ? 1 : 0));
const sqlVec = (v: number[]) => `[${v.join(',')}]`;
const noop = () => {};
const log = { info: noop, warn: noop, error: noop };

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  for (const [note, model, axis] of [['current', EMBED_MODEL, 1], ['other-model', 'gemini-embedding-001', 0]] as const) {
    await seedNote(note, 'ws-a', 'alice');
    await pool.query(
      `INSERT INTO embeddings (note_id, workspace_id, chunk_text, start_ms, end_ms, embedding, model)
         VALUES ($1, 'ws-a', 'zzqx chunk', 0, 1000, $2::vector, $3)`,
      [note, sqlVec(unit(axis)), model],
    );
  }
});
afterAll(async () => {
  await readPool.end();
  await pool.end();
});

describe('vector search and the embedding model', () => {
  it("ranks only rows from the query's model, even when another model's row is nearer", async () => {
    // The query vector equals the other model's row exactly (distance 0).
    const embed = async () => unit(0);
    const hits = await hybridSearch({ uid: 'alice', query: 'planning', k: 10, log, embed });
    expect(hits.map((h: { noteId: string }) => h.noteId)).toEqual(['current']);
  });

  it('keeps the model filter when narrowed to one note', async () => {
    const embed = async () => unit(0);
    expect(await hybridSearch({ uid: 'alice', query: 'planning', k: 10, log, embed, noteId: 'other-model' })).toEqual([]);
    const one = await hybridSearch({ uid: 'alice', query: 'planning', k: 10, log, embed, noteId: 'current' });
    expect(one.map((h: { noteId: string }) => h.noteId)).toEqual(['current']);
  });
});
