import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// Work that a retry can't redo must not be lost to a throw after the commit.
// - The last chunk's completion commits 'summarizing' and spends the summarizer
//   claim; a retry of its poll finds the chunk done and returns. So a failed
//   mirror there is logged, and the summarizer is still queued.
// - The fast path's 'ready' is conditional: a kickoff delivered twice can't
//   overwrite a finished note (and the edits made to it since).
// Real Postgres; Firestore and Cloud Tasks are fakes.
const require = createRequire(import.meta.url);
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const { NoteGoneError } = require('../../services/transcoder/src/note-gone.js');

const noop = () => {};
const errors: string[] = [];
const log: any = { info: noop, warn: noop, error: (_o: unknown, m: string) => void errors.push(m), child: () => log };
const blip = () => Object.assign(new Error('14 UNAVAILABLE: blip'), { code: 14 });

function deps({ progressErr, statusErr }: { progressErr?: Error; statusErr?: Error } = {}) {
  const queued: string[] = [];
  return {
    queued,
    d: {
      db: transcoderDb, log,
      storage: { deletePrefix: async () => {} },
      mirror: {
        mirrorProgress: async () => { if (progressErr) throw progressErr; },
        mirrorStatus: async () => { if (statusErr) throw statusErr; },
      },
      tasks: {
        enqueueSummarizer: async () => void queued.push('summarizer'),
        enqueueEmbedder: async () => void queued.push('embedder'),
      },
    },
  };
}

async function lastChunk() {
  // Two chunks; the first is done, so completing the second completes the note.
  const ids: string[] = [];
  for (const idx of [0, 1]) {
    const { rows } = await pool.query(
      `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status)
       VALUES ('n1', $1, $2, $3, 'gs://b/c', $4) RETURNING id`,
      [idx, idx * 600, idx * 600 + 630, idx === 0 ? 'done' : 'transcribing'],
    );
    ids.push(rows[0].id);
  }
  await pool.query(`UPDATE notes SET status = 'transcribing', chunks_total = 2, chunks_done = 1 WHERE id = 'n1'`);
  return ids[1];
}
const complete = (chunkId: string, d: any) => handler.completeChunkAndAdvance({
  noteId: 'n1', workspaceId: 'ws', chunkId, deps: d,
  lines: [{ speakerTag: 1, startMs: 600_000, endMs: 602_000, text: 'Last words.', confidence: 0.9 }],
});

beforeEach(async () => {
  await resetDb();
  errors.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

describe('the last chunk completes the note', () => {
  it('a Firestore blip on the progress mirror is logged, and the summarizer and embedder are still queued', async () => {
    const f = deps({ progressErr: blip() });
    await complete(await lastChunk(), f.d);
    expect(f.queued).toEqual(['summarizer', 'embedder']);
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('summarizing');
    expect(errors).toContain('chunk_complete_mirror_failed');
  });

  it("a blip on the 'summarizing' mirror: the same", async () => {
    const f = deps({ statusErr: blip() });
    await complete(await lastChunk(), f.d);
    expect(f.queued).toEqual(['summarizer', 'embedder']);
  });

  it("a doc that's gone still throws, for handle() to check against Postgres", async () => {
    const f = deps({ statusErr: new NoteGoneError('firestore') });
    await expect(complete(await lastChunk(), f.d)).rejects.toBeInstanceOf(NoteGoneError);
  });
});

describe('the completion gate is one transaction', () => {
  const failSummarizing = () => pool.query(`
    CREATE OR REPLACE FUNCTION test_gate_outage() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status = 'summarizing' THEN RAISE EXCEPTION 'simulated outage'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_gate_outage BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION test_gate_outage();`);
  const heal = () => pool.query(`DROP TRIGGER IF EXISTS test_gate_outage ON notes; DROP FUNCTION IF EXISTS test_gate_outage();`);

  it("an error part-way rolls the chunk back to not-done, so the poll's retry runs the whole gate", async () => {
    const chunkId = await lastChunk();
    await failSummarizing();
    try {
      await expect(complete(chunkId, deps().d)).rejects.toThrow(/simulated outage/);
      const row = (await pool.query(
        `SELECT c.status, n.summarizer_enqueued_at IS NULL AS unclaimed FROM audio_chunks c JOIN notes n ON n.id = c.note_id WHERE c.id = $1`,
        [chunkId],
      )).rows[0];
      expect(row).toEqual({ status: 'transcribing', unclaimed: true });
    } finally { await heal(); }

    const retry = deps();
    await complete(chunkId, retry.d);
    expect(retry.queued).toEqual(['summarizer', 'embedder']);
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('summarizing');
  });

  it('two last chunks completing at once: exactly one of them completes the note', async () => {
    for (let round = 0; round < 5; round++) {
      await pool.query(`DELETE FROM audio_chunks WHERE note_id = 'n1'`);
      await pool.query(`UPDATE notes SET status = 'transcribing', chunks_total = 2, chunks_done = 0, summarizer_enqueued_at = NULL, embedder_enqueued_at = NULL WHERE id = 'n1'`);
      const ids: string[] = [];
      for (const idx of [0, 1]) {
        const { rows } = await pool.query(
          `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status) VALUES ('n1', $1, 0, 1, 'gs://b/c', 'transcribing') RETURNING id`,
          [idx],
        );
        ids.push(rows[0].id);
      }
      const gate = async (chunkId: string) => {
        const c = await transcoderDb.pool().connect();
        try { return await transcoderDb.completeChunkGate(c, { chunkId, noteId: 'n1', workspaceId: 'ws', log }); } finally { c.release(); }
      };
      const results = await Promise.all(ids.map(gate));
      expect(results.filter((r: any) => r.summarizerClaimed)).toHaveLength(1);
      expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('summarizing');
    }
  });

  it('a summarizer enqueue that throws still lets the embedder be queued, then surfaces', async () => {
    const f = deps();
    f.d.tasks.enqueueSummarizer = async () => { throw new Error('tasks down'); };
    await expect(complete(await lastChunk(), f.d)).rejects.toThrow('tasks down');
    expect(f.queued).toEqual(['embedder']);
    expect(errors).toContain('chunk_complete_enqueue_failed');
  });
});

describe("the fast path's commit", () => {
  const persist = () => transcoderDb.persistFastPathResult(transcoderDb.pool(), {
    noteId: 'n1', workspaceId: 'ws', model: 'm',
    lines: [{ startMs: 0, text: 'Speaker 1: again' }],
    summary: { gist: 'second run', actionItems: ['generated again'], keyDecisions: [] },
  }, log);

  it("a second delivery can't overwrite a finished note, or the edits made to it", async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    await pool.query(`INSERT INTO summaries (note_id, gist) VALUES ('n1', 'first run')`);
    await pool.query(`INSERT INTO action_items (note_id, text) VALUES ('n1', 'edited by the user')`);
    await expect(persist()).rejects.toMatchObject({ code: 'NOTE_MOVED_ON' });
    expect((await pool.query(`SELECT gist FROM summaries WHERE note_id = 'n1'`)).rows[0].gist).toBe('first run');
    expect((await pool.query(`SELECT text FROM action_items WHERE note_id = 'n1'`)).rows.map((r: any) => r.text)).toEqual(['edited by the user']);
  });

  it('a note still in progress is committed as before', async () => {
    await pool.query(`UPDATE notes SET status = 'chunking' WHERE id = 'n1'`);
    await persist();
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status).toBe('ready');
  });
});
