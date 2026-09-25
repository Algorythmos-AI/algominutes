import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { NoteReadResponse } from '@algominutes/contracts/schemas';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// POST /v1/notes/read carries the summary's chapters, and its response still
// validates against the published contract (NoteReadResponse).
const require = createRequire(import.meta.url);
const { handleNoteRead } = require('../../services/api/src/routes/note-read.cjs');
const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };

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

describe('note read and chapters', () => {
  it("returns the summary's chapters, in a response that matches the contract", async () => {
    const chapters = [{ startMs: 0, title: 'Intros', summary: 'Hello.' }, { startMs: 1_800_000, title: 'Budget', summary: '' }];
    await pool.query(`INSERT INTO summaries (note_id, gist, chapters) VALUES ('n1', 'Planning.', $1)`, [JSON.stringify(chapters)]);
    const out = await handleNoteRead({ uid: 'alice', body: { noteId: 'n1', workspaceId: 'workspace_alice' }, log });
    expect(out.status).toBe(200);
    expect(out.body.summary.chapters).toEqual(chapters);
    const parsed = NoteReadResponse.safeParse(out.body);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  // seedNote leaves the title unset, as the kickoff does for every real note.
  it('an older summary (no chapters written) reads as none, still valid', async () => {
    await pool.query(`INSERT INTO summaries (note_id, gist) VALUES ('n1', 'Old.')`);
    const out = await handleNoteRead({ uid: 'alice', body: { noteId: 'n1', workspaceId: 'workspace_alice' }, log });
    expect(out.body.summary.chapters).toEqual([]);
    const parsed = NoteReadResponse.safeParse(out.body);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });
});
