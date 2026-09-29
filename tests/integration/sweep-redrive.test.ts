import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The sweep re-drives lost pipeline work (RELEASE.md PR 5c; audit Q9–Q11): a summary or an embed whose task
// was lost after its claim gets its task again, once per window, and nothing that's merely slow, done, failed,
// a regeneration or given up on is touched. Real Postgres; the task queue is a fake.
const require = createRequire(import.meta.url);
const sweep = require('../../services/db-job/src/handlers/sweep.js');
const noteTerminal = require('@algominutes/db/note-terminal.cjs');

const MIN = 60 * 1000;
const warns: string[] = [];
const errors: string[] = [];
const log: any = {
  info: () => {}, warn: (_o: unknown, m: string) => void warns.push(m), error: (_o: unknown, m: string) => void errors.push(m), child() { return log; },
};
const fsFake = { doc: () => ({ update: async () => {} }), collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) };
const deps = { auth: { deleteUser: async () => {} }, firestore: fsFake, bucket: { getFiles: async () => [[]] } };

function run({ failEnqueue = false } = {}) {
  const sent: Array<{ worker: string; payload: any }> = [];
  const enqueueWorker = async (worker: string, payload: any) => {
    if (failEnqueue) throw new Error('tasks 503');
    sent.push({ worker, payload });
    return 'enqueued';
  };
  return sweep.run({ log, env: {}, traceId: 't-redrive', deps, repo, noteTerminal, enqueueWorker }).then(() => sent);
}
const at = (ms: number) => new Date(Date.now() - ms).toISOString();
async function note(id: string, sql: string, params: unknown[] = []) {
  await seedNote(id, 'ws', 'alice');
  await pool.query(`UPDATE notes SET ${sql} WHERE id = '${id}'`, params);
}
const lines = (id: string) => pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ($1, 0, 1000, 'hello')`, [id]);

beforeEach(async () => {
  warns.length = 0;
  errors.length = 0;
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws', 'alice');
});
afterAll(async () => {
  await pool.end();
  await repo.getPool().end();
});

describe('a lost summary', () => {
  it('a note summarizing since its claim, untouched past the window, gets its summarizer task again, once', async () => {
    await note('lost', `status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $1`, [at(100 * MIN)]);
    const sent = await run();
    expect(sent).toEqual([{ worker: 'summarizer', payload: { noteId: 'lost', workspaceId: 'ws', uid: 'alice' } }]);
    expect(warns).toContain('lost_work_redriven');
    // Re-stamped: the next sweep, minutes later, leaves it alone.
    expect(await run()).toEqual([]);
  });

  it('leaves alone one inside the window (its task may still be retrying), a regeneration, and one that moved', async () => {
    await note('slow', `status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $1`, [at(60 * MIN)]);
    await note('regen', `status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $1, summary_requested_at = $1`, [at(100 * MIN)]);
    await note('moved', `status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $2`, [at(100 * MIN), at(5 * MIN)]);
    await note('done', `status = 'ready', summarizer_enqueued_at = $1, updated_at = $1`, [at(100 * MIN)]);
    expect((await run()).filter((s) => s.worker === 'summarizer')).toEqual([]);
  });

  it("an enqueue that fails is logged and the step fails, and the claim stands for the next window", async () => {
    await note('lost', `status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $1`, [at(100 * MIN)]);
    // The job exits non-zero, so the failure is seen (the sweep_step_failed alert).
    await expect(run({ failEnqueue: true })).rejects.toThrow(/redrive/);
    expect(errors).toEqual(expect.arrayContaining(['redrive_enqueue_failed', 'sweep_step_failed']));
    const stamped = (await pool.query(`SELECT summarizer_enqueued_at FROM notes WHERE id = 'lost'`)).rows[0].summarizer_enqueued_at;
    expect(Date.now() - stamped.getTime()).toBeLessThan(MIN);
  });
});

describe('a lost embed', () => {
  it('a ready note with a transcript and no embeddings, claimed past the window, gets its embedder task again', async () => {
    await note('lost', `status = 'ready', embedder_enqueued_at = $1`, [at(100 * MIN)]);
    await lines('lost');
    expect(await run()).toEqual([{ worker: 'embedder', payload: { noteId: 'lost', workspaceId: 'ws', uid: 'alice' } }]);
    expect(await run()).toEqual([]);
  });

  it('leaves alone one embedded, one with no transcript, one given up on (dead-lettered), and one outside the window', async () => {
    await note('embedded', `status = 'ready', embedder_enqueued_at = $1`, [at(100 * MIN)]);
    await lines('embedded');
    await pool.query(`INSERT INTO embeddings (note_id, workspace_id, chunk_text, embedding, model) VALUES ('embedded', 'ws', 'x', array_fill(0, ARRAY[768])::vector, 'm')`);
    await note('silent', `status = 'ready', embedder_enqueued_at = $1`, [at(100 * MIN)]);
    await note('given-up', `status = 'ready', embedder_enqueued_at = $1`, [at(100 * MIN)]);
    await lines('given-up');
    await pool.query(`INSERT INTO dead_letter (queue, note_id, workspace_id, error) VALUES ('embed', 'given-up', 'ws', 'x')`);
    await note('old', `status = 'ready', embedder_enqueued_at = $1`, [at(7 * 60 * MIN)]);
    await lines('old');
    await note('recent', `status = 'ready', embedder_enqueued_at = $1`, [at(30 * MIN)]);
    await lines('recent');
    expect(await run()).toEqual([]);
  });
});

describe('another workspace', () => {
  it("each note's own user and workspace go with its task", async () => {
    await seedUser('bob');
    await seedWorkspace('ws-b', 'bob');
    await seedNote('bobs', 'ws-b', 'bob');
    await pool.query(`UPDATE notes SET status = 'summarizing', summarizer_enqueued_at = $1, updated_at = $1 WHERE id = 'bobs'`, [at(100 * MIN)]);
    expect(await run()).toEqual([{ worker: 'summarizer', payload: { noteId: 'bobs', workspaceId: 'ws-b', uid: 'bob' } }]);
  });
});
