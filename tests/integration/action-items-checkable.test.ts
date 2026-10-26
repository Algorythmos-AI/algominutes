import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { applyNoteEdit, getPool, markSummaryReady } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';
// @ts-expect-error: plain ESM route module, no type declarations
import { actionItemStatusRoute } from '../../services/api/src/routes/action-item.js';

// An action item can be ticked, and the tick is kept: through the real route, against real Postgres; two
// accounts, as every query that touches user data is tested (CLAUDE.md §1).
const require = createRequire(import.meta.url);
const apiPool = require('@algominutes/ai/pg-query.cjs').pool();

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const firestore: any = { doc: () => ({ update: async () => {} }) };
// What markSummaryReady needs of Firestore: a doc it can read and update.
const firestoreOk: any = { doc: () => ({ update: async () => {}, set: async () => {}, get: async () => ({ exists: true, data: () => ({ status: 'summarizing' }) }) }) };
const WS = 'workspace_alice';

async function tick(uid: string, body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.status ||= 200; out.body = b; return this; } };
  await actionItemStatusRoute({ uid, log, body }, res);
  return out;
}
const items = async () =>
  (await pool.query(`SELECT id, text, status, completed_at IS NOT NULL AS stamped FROM action_items WHERE note_id = 'n1' ORDER BY position`)).rows;
const edit = (actionItems: string[]) =>
  applyNoteEdit(firestore, { noteId: 'n1', workspaceId: WS, summary: { gist: 'g', actionItems, keyDecisions: [] } }, quietLog);

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace(WS, 'alice');
  await seedNote('n1', WS, 'alice');
  await seedUser('bob');
  await seedWorkspace('workspace_bob', 'bob');
  await edit(['Send the deck', 'Book the room', 'Email finance']);
});
afterAll(async () => {
  await apiPool.end();
  await pool.end();
  await getPool().end();
});

describe('POST /v1/notes/action-items/status', () => {
  it('ticks an item, stamps when, and unticks it again', async () => {
    const [deck] = await items();
    const done = await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true });
    expect(done).toEqual({ status: 200, body: { ok: true, noteId: 'n1', itemId: deck.id, status: 'done' } });
    expect((await items())[0]).toMatchObject({ text: 'Send the deck', status: 'done', stamped: true });
    expect((await items()).slice(1).map((i) => i.status)).toEqual(['open', 'open']);
    const open = await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: false });
    expect(open.body.status).toBe('open');
    expect((await items())[0]).toMatchObject({ status: 'open', stamped: false });
  });

  it('ticking twice is the same as once, and keeps the first time', async () => {
    const [deck] = await items();
    await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true });
    const first = (await pool.query(`SELECT completed_at FROM action_items WHERE id = $1`, [deck.id])).rows[0].completed_at;
    expect((await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true })).status).toBe(200);
    expect((await pool.query(`SELECT completed_at FROM action_items WHERE id = $1`, [deck.id])).rows[0].completed_at).toEqual(first);
  });

  it("someone outside the workspace can't tick it, whichever workspace they name", async () => {
    const [deck] = await items();
    // Naming their own workspace: the item isn't on a note there.
    expect((await tick('bob', { noteId: 'n1', workspaceId: 'workspace_bob', itemId: deck.id, done: true })).status).toBe(404);
    // Naming alice's: refused before any query.
    expect((await tick('bob', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true })).status).toBe(403);
    expect((await items())[0].status).toBe('open');
  });

  it('an item of another note, a deleted note or no item at all is not found', async () => {
    const [deck] = await items();
    await seedNote('n2', WS, 'alice');
    expect((await tick('alice', { noteId: 'n2', workspaceId: WS, itemId: deck.id, done: true })).status).toBe(404);
    expect((await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: '00000000-0000-4000-8000-000000000000', done: true })).status).toBe(404);
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect((await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true })).status).toBe(404);
    expect((await items())[0].status).toBe('open');
  });

  it('refuses a malformed request before it reaches the database', async () => {
    const [deck] = await items();
    for (const body of [
      { noteId: 'n1', workspaceId: WS, itemId: 'not-a-uuid', done: true },
      { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: 'yes' },
      { noteId: 'n1', workspaceId: WS, itemId: deck.id },
      { workspaceId: WS, itemId: deck.id, done: true },
    ]) {
      expect((await tick('alice', body)).status).toBe(400);
    }
  });
});

describe('a tick and the summary', () => {
  it("a manual edit keeps the ticks of the items it didn't change, wherever they move to", async () => {
    const [deck, , finance] = await items();
    await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true });
    await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: finance.id, done: true });
    // Reordered, one reworded, one added.
    await edit(['Email finance', 'Book the big room', 'Send the deck', 'Order lunch']);
    expect((await items()).map((i) => [i.text, i.status, i.stamped])).toEqual([
      ['Email finance', 'done', true],
      ['Book the big room', 'open', false],
      ['Send the deck', 'done', true],
      ['Order lunch', 'open', false],
    ]);
  });

  it('two items with the same words keep their own ticks, in order', async () => {
    await edit(['Follow up', 'Follow up']);
    const [first] = await items();
    await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: first.id, done: true });
    await edit(['Follow up', 'Follow up', 'Follow up']);
    expect((await items()).map((i) => i.status)).toEqual(['done', 'open', 'open']);
  });

  it("a rewrite by the model starts every item open: they're new items", async () => {
    const [deck] = await items();
    await tick('alice', { noteId: 'n1', workspaceId: WS, itemId: deck.id, done: true });
    // The summarizer's own writer, as a regenerate runs it.
    const gen = (await pool.query(`SELECT summary_generation FROM notes WHERE id = 'n1'`)).rows[0].summary_generation;
    await markSummaryReady(firestoreOk, {
      noteId: 'n1', workspaceId: WS, summary: { gist: 'g2', actionItems: ['Send the deck', 'Book the room'], keyDecisions: [] },
      transcriptPreview: [], transcriptTruncated: false, expectedGeneration: Number(gen),
    } as never, log);
    expect((await items()).map((i) => [i.text, i.status, i.stamped])).toEqual([
      ['Send the deck', 'open', false],
      ['Book the room', 'open', false],
    ]);
  });
});
