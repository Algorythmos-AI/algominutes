import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { applyNoteEdit, getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

// A summary edit mirrors by field path: the doc keeps what the edit didn't
// carry. Replacing the `summary` map dropped `summary.chapters`, so editing one
// action item removed a long recording's chapters from the app. Real Postgres;
// the Firestore fake applies dotted keys as field paths, as the Admin SDK does.
const docs = new Map<string, any>();
const firestore: any = {
  doc: (p: string) => ({
    update: async (patch: Record<string, unknown>) => {
      const d = docs.get(p);
      if (!d) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      for (const [k, v] of Object.entries(patch)) {
        if (k.includes('.')) {
          const [a, b] = k.split('.') as [string, string];
          d[a] = { ...(d[a] || {}), [b]: v };
        } else d[k] = v;
      }
    },
  }),
};
const DOC = 'workspaces/ws/notes/n1';
const chapters = [{ startMs: 0, title: 'Intro' }, { startMs: 600_000, title: 'Budget' }];

beforeEach(async () => {
  await resetDb();
  docs.clear();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  docs.set(DOC, { status: 'ready', summary: { gist: 'Old gist.', actionItems: ['Old'], keyDecisions: [], chapters, keyPoints: ['kept'] } });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('applyNoteEdit: the mirror', () => {
  it("an edit to the summary keeps its chapters and a key-points list it didn't send", async () => {
    await applyNoteEdit(firestore, {
      noteId: 'n1', workspaceId: 'ws',
      summary: { gist: 'Edited gist.', actionItems: ['Send the deck'], keyDecisions: ['Ship Friday'] },
    }, quietLog);
    expect(docs.get(DOC).summary).toEqual({
      gist: 'Edited gist.', actionItems: ['Send the deck'], keyDecisions: ['Ship Friday'], chapters, keyPoints: ['kept'],
    });
  });

  it('writes only the fields an edit carries, even if handed more', async () => {
    await applyNoteEdit(firestore, {
      noteId: 'n1', workspaceId: 'ws',
      summary: { gist: 'g', actionItems: [], keyDecisions: [], chapters: [] } as never,
    }, quietLog);
    expect(docs.get(DOC).summary.chapters).toEqual(chapters);
  });

  it('a rename touches only the title', async () => {
    await applyNoteEdit(firestore, { noteId: 'n1', workspaceId: 'ws', title: 'Renamed' }, quietLog);
    expect(docs.get(DOC)).toMatchObject({ title: 'Renamed', summary: { gist: 'Old gist.', chapters } });
  });
});
