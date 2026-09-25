import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// indexEmbeddings must fail loudly: the embedder answers 5xx on a throw, so Cloud
// Tasks retries and the last attempt dead-letters. It used to log and return
// chunkCount 0, which the embedder answered 200: never retried, the note silently
// absent from Search and Chat.
const require = createRequire(import.meta.url);
const { indexEmbeddings, EMBED_DIM } = require('@algominutes/ai/embeddings.cjs');
const noop = () => {};
const log = { info: noop, warn: noop, error: noop };
const transcript = [{ speaker: 'A', text: 'We agreed to ship the beta on Friday after the review.', time: '00:05' }];
const vector = () => Array.from({ length: EMBED_DIM }, () => 0.01);

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  await seedNote('n1', 'ws-a', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('indexEmbeddings failures are loud', () => {
  it('writes the vectors on success', async () => {
    const embed = async ({ chunks }: { chunks: unknown[] }) => chunks.map(vector);
    const r = await indexEmbeddings({ pool, noteId: 'n1', workspaceId: 'ws-a', transcript, log, embed });
    expect(r.chunkCount).toBeGreaterThan(0);
    expect(await count(`SELECT 1 FROM embeddings WHERE note_id = 'n1'`)).toBe(r.chunkCount);
  });

  it('throws when the embedding call fails, and writes nothing', async () => {
    const embed = async () => { throw new Error('vertex 503'); };
    await expect(indexEmbeddings({ pool, noteId: 'n1', workspaceId: 'ws-a', transcript, log, embed })).rejects.toThrow('vertex 503');
    expect(await count(`SELECT 1 FROM embeddings`)).toBe(0);
  });

  it('throws when the vectors do not match the chunks', async () => {
    const embed = async () => [];
    await expect(indexEmbeddings({ pool, noteId: 'n1', workspaceId: 'ws-a', transcript, log, embed })).rejects.toThrow(/vectors for/);
  });

  it('a deleted note surfaces as the foreign-key error (23503) the embedder acknowledges', async () => {
    const embed = async ({ chunks }: { chunks: unknown[] }) => chunks.map(vector);
    await expect(indexEmbeddings({ pool, noteId: 'gone', workspaceId: 'ws-a', transcript, log, embed })).rejects.toMatchObject({ code: '23503' });
    expect(await count(`SELECT 1 FROM embeddings`)).toBe(0);
  });
});
