import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// /v1/search and chat retrieval compare the query's vector only with rows
// embedded by the same model. Vectors from different models don't compare,
// and the text-embedding-004 → gemini-embedding-001 migration (due before
// 2027-04-01) re-embeds in place, so both kinds of row will coexist.
const require = createRequire(import.meta.url);
const { hybridSearch, handleSearch, handleChatStream, chatRequestBody } = require('../../services/api/src/routes/search-and-chat.cjs');
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

describe('the search log line', () => {
  it("carries the query's length, not its text", async () => {
    const lines: Array<{ o: any; m: string }> = [];
    const at = (o: any, m: string) => void lines.push({ o, m });
    const res = await handleSearch({
      uid: 'alice', body: { query: 'zzqx Henderson renewal' }, log: { info: at, warn: at, error: at }, embed: async () => unit(1),
    });
    expect(res.status).toBe(200);
    const ok = lines.find((l) => l.m === 'search_ok');
    expect(ok?.o).toMatchObject({ queryLen: 'zzqx Henderson renewal'.length, hitCount: 1 });
    expect(JSON.stringify(lines)).not.toContain('Henderson');
  });

  it('a search narrowed to one note logs its noteId; a malformed id is not echoed', async () => {
    const lines: Array<{ o: any; m: string }> = [];
    const logger = (bound: Record<string, unknown>): any => {
      const at = (o: any, m: string) => void lines.push({ o: { ...bound, ...o }, m });
      return { info: at, warn: at, error: at, child: (f: Record<string, unknown>) => logger({ ...bound, ...f }) };
    };
    await handleSearch({ uid: 'alice', body: { query: 'zzqx', noteId: 'current' }, log: logger({}), embed: async () => unit(1) });
    expect(lines.find((l) => l.m === 'search_ok')?.o).toMatchObject({ noteId: 'current', hitCount: 1 });

    lines.length = 0;
    await handleSearch({ uid: 'alice', body: { query: 'zzqx', noteId: 'not an id <script>' }, log: logger({}), embed: async () => unit(1) });
    expect(JSON.stringify(lines)).not.toContain('<script>');
  });
});

// RELEASE.md rev 11, L4 and N7 (H9a).
describe('search and chat limits', () => {
  it('a question over 2,000 characters is refused before anything is embedded or asked', async () => {
    let embedded = 0;
    const embed = async () => { embedded++; return unit(1); };
    expect((await handleSearch({ uid: 'alice', body: { query: 'q'.repeat(2001) }, log, embed })).status).toBe(400);
    expect((await handleSearch({ uid: 'alice', body: { query: 'q'.repeat(2000) }, log, embed })).status).toBe(200);
    expect(embedded).toBe(1);

    const out = { status: 0, body: undefined as any };
    const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
    await handleChatStream({ uid: 'alice', body: { query: 'q'.repeat(2001) }, log, res });
    expect(out).toEqual({ status: 400, body: { error: expect.stringMatching(/2,000 characters/) } });
  });

  it("a note whose run failed isn't searched: its embeddings and lines may be from an earlier run", async () => {
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'current'`);
    await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('current', 0, 1000, 'zzqx planning budget')`);
    const hits = await hybridSearch({ uid: 'alice', query: 'zzqx planning budget', k: 10, log, embed: async () => unit(1) });
    expect(hits.map((h: { noteId: string }) => h.noteId)).not.toContain('current');
  });

  it("chat asks Vertex for a bounded answer, with the model's thinking capped", () => {
    const body = chatRequestBody('the prompt');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'the prompt' }] }]);
    // The chat model is gemini-3.x: its cap is thinkingLevel (thinkingBudget is refused by some of its backends).
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(chatRequestBody('p', 'gemini-2.5-flash').generationConfig.thinkingConfig).toEqual({ thinkingBudget: 1024 });
  });
});
