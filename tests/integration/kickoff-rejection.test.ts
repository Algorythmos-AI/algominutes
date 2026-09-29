import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, markKickoffRejected } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

// markKickoffRejected: a kickoff refused before it queued marks the note
// failed, unless a duplicate kickoff has it in flight.
const docs = new Map<string, Record<string, unknown>>();
const fs = {
  doc: (path: string) => ({
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
  }),
} as never;
const DOC = 'workspaces/ws-a/notes/n1';
const input = { noteId: 'n1', workspaceId: 'ws-a', errorMessage: 'too many' };
const status = async () => (await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0]?.status;

beforeEach(async () => {
  await resetDb();
  docs.clear();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  docs.set(DOC, { status: 'queued' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('markKickoffRejected', () => {
  it.each(['queued', 'chunking', 'transcribing', 'summarizing'])('spares a note %s moments ago: Postgres and the doc', async (s) => {
    await seedNote('n1', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET status = $1 WHERE id = 'n1'`, [s]);
    docs.set(DOC, { status: s });
    expect(await markKickoffRejected(fs, input, quietLog)).toEqual({ marked: false });
    expect(await status()).toBe(s);
    expect(docs.get(DOC)).toEqual({ status: s });
  });

  it('leaves a note stuck in flight past the stale window for the sweep, which fails and refunds it', async () => {
    // Its run was charged. Marking it `error` here (with no refund) would take it
    // out of listStuckNotes and strand the charge (RELEASE.md PR 3 audit).
    await seedNote('n1', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`);
    docs.set(DOC, { status: 'transcribing' });
    expect(await markKickoffRejected(fs, input, quietLog)).toEqual({ marked: false });
    expect(await status()).toBe('transcribing');
    expect(docs.get(DOC)).toEqual({ status: 'transcribing' });
  });

  it('marks a failed or finished note', async () => {
    await seedNote('n1', 'ws-a', 'alice');
    for (const from of ['error', 'ready']) {
      await pool.query(`UPDATE notes SET status = $1 WHERE id = 'n1'`, [from]);
      expect(await markKickoffRejected(fs, input, quietLog)).toEqual({ marked: true });
      expect(await status()).toBe('error');
    }
    expect(docs.get(DOC)).toMatchObject({ status: 'error', errorMessage: 'too many' });
  });

  it('a note with no Postgres row yet gets the mirror only', async () => {
    expect(await markKickoffRejected(fs, input, quietLog)).toEqual({ marked: true });
    expect(docs.get(DOC)).toMatchObject({ status: 'error' });
  });

  it("a note of that id in another workspace is untouched; only this workspace's doc is marked", async () => {
    await seedUser('bob');
    await seedWorkspace('ws-b', 'bob');
    await seedNote('n1', 'ws-b', 'bob');
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    expect(await markKickoffRejected(fs, input, quietLog)).toEqual({ marked: true });
    expect(await status()).toBe('ready');
  });

  // The duplicate queues the note while the refusal is in flight: the refusal
  // waits for the row, and re-checks it once the duplicate commits.
  it("a duplicate's queue committing mid-refusal spares the note", async () => {
    await seedNote('n1', 'ws-a', 'alice');
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
    const twin = await pool.connect();
    try {
      await twin.query('BEGIN');
      await twin.query(`UPDATE notes SET status = 'queued', updated_at = NOW() WHERE id = 'n1'`);
      const refusal = markKickoffRejected(fs, input, quietLog);
      await new Promise((r) => setTimeout(r, 200));
      await twin.query('COMMIT');
      expect(await refusal).toEqual({ marked: false });
    } finally {
      twin.release();
    }
    expect(await status()).toBe('queued');
  });
});
