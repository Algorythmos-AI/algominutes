import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { getPool, markReady, markSummaryReady } from '@algominutes/db';
import { pool, resetDb, seedNote, seedUser, seedWorkspace } from './helpers';

// RELEASE.md PR 30b (audit Q22): action items and key decisions in the order the summary gave them. A
// summary's items are written in one transaction, so they share created_at, and their id is a random UUID:
// ordering by it shuffled them. Each writer stores the index; each reader orders by it. Real Postgres.
const require = createRequire(import.meta.url);
const { writeNoteEditWithinTx } = require('@algominutes/db/note-edit.cjs');
const { persistFastPathResult } = require('@algominutes/db/pipeline-repo.cjs');
const { handleNoteRead } = require('../../services/api/src/routes/note-read.cjs');
const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const fsOk = { doc: () => ({ update: async () => {}, set: async () => {}, get: async () => ({ exists: true, data: () => ({}) }) }) } as never;

// Twelve of each: in the order a random UUID gives them, twelve come back right once in 479 million.
const ITEMS = Array.from({ length: 12 }, (_, i) => `Action ${String(i + 1).padStart(2, '0')}`);
const DECISIONS = Array.from({ length: 12 }, (_, i) => `Decision ${String(i + 1).padStart(2, '0')}`);

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  await seedNote('n1', 'workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
  await require('@algominutes/ai/pg-query.cjs').getPool?.()?.end?.();
});

const stored = async (table: string) =>
  (await pool.query(`SELECT text, position FROM ${table} WHERE note_id = 'n1' ORDER BY position`)).rows;
async function expectInOrder() {
  expect(await stored('action_items')).toEqual(ITEMS.map((text, position) => ({ text, position })));
  expect(await stored('key_decisions')).toEqual(DECISIONS.map((text, position) => ({ text, position })));
  const out = await handleNoteRead({ uid: 'alice', body: { noteId: 'n1', workspaceId: 'workspace_alice' }, log });
  expect(out.status).toBe(200);
  expect(out.body.summary.actionItems.map((a: { text: string }) => a.text)).toEqual(ITEMS);
  expect(out.body.summary.keyDecisions.map((d: { text: string }) => d.text)).toEqual(DECISIONS);
}

describe("a summary's items keep their order", () => {
  it('written by the summarizer (markSummaryReady)', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    await markSummaryReady(fsOk, {
      noteId: 'n1', workspaceId: 'workspace_alice', summary: { gist: 'g', actionItems: ITEMS, keyDecisions: DECISIONS },
      transcriptPreview: [], transcriptTruncated: false, expectedGeneration: 0,
    } as never, log);
    await expectInOrder();
  });

  it("written by the fast path (persistFastPathResult)", async () => {
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    await persistFastPathResult(getPool(), {
      noteId: 'n1', workspaceId: 'workspace_alice', lines: [], summary: { gist: 'g', actionItems: ITEMS, keyDecisions: DECISIONS }, model: null,
    }, log, { enqueueNotice: async () => {} });
    await expectInOrder();
  });

  it("written by the user's edit (writeNoteEditWithinTx)", async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await writeNoteEditWithinTx(client, { noteId: 'n1', workspaceId: 'workspace_alice', summary: { gist: 'g', actionItems: ITEMS, keyDecisions: DECISIONS } });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await expectInOrder();
  });

  it('written by markReady', async () => {
    await markReady(fsOk, {
      noteId: 'n1', workspaceId: 'workspace_alice', authorUid: 'alice', sourceType: 'recording',
      summary: { gist: 'g', actionItems: ITEMS, keyDecisions: DECISIONS },
    } as never, log);
    await expectInOrder();
  });

  it('rows from before positions still read, as before', async () => {
    await pool.query(`INSERT INTO action_items (note_id, text) VALUES ('n1', 'Old one')`);
    await pool.query(`INSERT INTO summaries (note_id, gist) VALUES ('n1', 'g')`);
    const out = await handleNoteRead({ uid: 'alice', body: { noteId: 'n1', workspaceId: 'workspace_alice' }, log });
    expect(out.body.summary.actionItems.map((a: { text: string }) => a.text)).toEqual(['Old one']);
  });
});

describe('every reader', () => {
  it('orders the items by their position first: the note, export, share and mirror-repair reads', () => {
    const readers = ['services/api/src/routes/note-read.cjs', 'services/api/src/routes/export-note.cjs', 'services/api/src/routes/shared-note.cjs', 'packages/db/src/mirror-repair.ts'];
    for (const f of readers) {
      const src = fs.readFileSync(f, 'utf8');
      const reads = [...src.matchAll(/FROM (?:action_items|key_decisions)\b[\s\S]{0,200}?ORDER BY ([^`'\n]+)/g)].map((m) => m[1]);
      expect(reads.length, f).toBeGreaterThanOrEqual(2);
      for (const order of reads) expect(order, f).toMatch(/^(?:s\.)?position (?:ASC )?NULLS LAST/);
    }
  });

  it('and every writer stores it', () => {
    for (const f of ['packages/db/src/notes-repo.ts', 'packages/db/src/note-edit.cjs', 'packages/db/src/pipeline-repo.cjs']) {
      const src = fs.readFileSync(f, 'utf8');
      const inserts = [...src.matchAll(/INSERT INTO (?:action_items|key_decisions) \(([^)]*)\)/g)].map((m) => m[1]);
      expect(inserts.length, f).toBeGreaterThanOrEqual(2);
      for (const cols of inserts) expect(cols, f).toContain('position');
    }
  });
});
