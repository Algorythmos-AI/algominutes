import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, markSummaryReady } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

// The summarizer's final write used to be inline SQL + a direct Firestore set
// in services/summarizer (allowlisted as a TODO), with an UPDATE that was not
// workspace-scoped. It is now notesRepo.markSummaryReady.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob');
  await seedNote('note-a', 'ws-a', 'alice');
  await pool.query(`UPDATE notes SET status = 'summarizing', summary_manually_edited_at = NOW(), summary_requested_at = NOW() WHERE id = 'note-a'`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

function fsStub({ missing = false, deleteNoteFirst = false } = {}) {
  const writes: Array<{ path: string; data: any }> = [];
  const update = async (path: string, data: any) => {
    // A delete (POST /v1/notes/delete) landing between the commit and the mirror.
    if (deleteNoteFirst) await pool.query(`DELETE FROM notes WHERE id = 'note-a'`);
    // What Firestore does for update() on a missing doc.
    if (missing) throw Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 });
    writes.push({ path, data });
  };
  return {
    fs: {
      doc: (path: string) => ({
        update: (data: any) => update(path, data),
        set: async () => { throw new Error('set() would re-create a deleted note'); },
      }),
    } as never,
    writes,
  };
}
const input = (over: Record<string, unknown> = {}) => ({
  noteId: 'note-a',
  workspaceId: 'ws-a',
  summary: { gist: 'We agreed to ship.', actionItems: ['Ship it', 'Tell sales'], keyDecisions: ['Ship Friday'] },
  model: 'gemini-3.5-flash',
  transcriptPreview: [{ speaker: 'Alice', text: 'hi', time: '00:01' }],
  transcriptTruncated: false,
  expectedGeneration: 0,
  ...over,
});

describe('markSummaryReady (summarizer final write)', () => {
  it('writes the summary, marks ready, clears the edit/regenerate flags, then mirrors', async () => {
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input(), quietLog)).toEqual({ written: true });
    const { rows } = await pool.query(
      `SELECT status, summary_manually_edited_at, summary_requested_at FROM notes WHERE id = 'note-a'`,
    );
    expect(rows[0]).toEqual({ status: 'ready', summary_manually_edited_at: null, summary_requested_at: null });
    expect((await pool.query(`SELECT gist, model FROM summaries WHERE note_id = 'note-a'`)).rows[0]).toEqual({ gist: 'We agreed to ship.', model: 'gemini-3.5-flash' });
    expect(await count(`SELECT 1 FROM action_items WHERE note_id = 'note-a'`)).toBe(2);
    expect(await count(`SELECT 1 FROM key_decisions WHERE note_id = 'note-a'`)).toBe(1);
    // An update (never a set, which would re-create a deleted note), with the
    // summary by field path so a Firestore-only summary.keyPoints survives.
    expect(writes).toEqual([{
      path: 'workspaces/ws-a/notes/note-a',
      data: {
        status: 'ready',
        updatedAt: expect.any(String),
        'summary.gist': 'We agreed to ship.',
        'summary.actionItems': ['Ship it', 'Tell sales'],
        'summary.keyDecisions': ['Ship Friday'],
        'summary.chapters': [],
        transcript: [{ speaker: 'Alice', text: 'hi', time: '00:01' }],
        transcriptTruncated: false,
      },
    }]);
  });

  it("stores a long recording's chapters with its summary, mirrors them, and a later summary replaces them", async () => {
    const chapters = [
      { startMs: 0, title: 'Intros', summary: 'Everyone joined.' },
      { startMs: 1_800_000, title: 'Budget', summary: 'Numbers for Q4.' },
    ];
    const { fs, writes } = fsStub();
    await markSummaryReady(fs, input({ summary: { ...input().summary, chapters } }), quietLog);
    expect((await pool.query(`SELECT chapters FROM summaries WHERE note_id = 'note-a'`)).rows[0].chapters).toEqual(chapters);
    expect(writes[0].data['summary.chapters']).toEqual(chapters);
    // A regenerate of the same note that yields no chapters clears them in both stores.
    await pool.query(`UPDATE notes SET summary_generation = 1 WHERE id = 'note-a'`);
    await markSummaryReady(fs, input({ expectedGeneration: 1 }), quietLog);
    expect((await pool.query(`SELECT chapters FROM summaries WHERE note_id = 'note-a'`)).rows[0].chapters).toEqual([]);
    expect(writes[1].data['summary.chapters']).toEqual([]);
  });

  it('is idempotent on a replayed task (no duplicate rows)', async () => {
    const { fs } = fsStub();
    await markSummaryReady(fs, input(), quietLog);
    await markSummaryReady(fs, input(), quietLog);
    expect(await count(`SELECT 1 FROM action_items WHERE note_id = 'note-a'`)).toBe(2);
    expect(await count(`SELECT 1 FROM summaries WHERE note_id = 'note-a'`)).toBe(1);
  });

  const expectUntouched = async (writes: unknown[]) => {
    expect(writes).toEqual([]);
    expect(await count(`SELECT 1 FROM summaries WHERE note_id = 'note-a'`)).toBe(0);
    expect(await count(`SELECT 1 FROM action_items WHERE note_id = 'note-a'`)).toBe(0);
    expect(await count(`SELECT 1 FROM key_decisions WHERE note_id = 'note-a'`)).toBe(0);
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'note-a'`)).rows[0].status).toBe('summarizing');
  };

  it("writes nothing, anywhere, for a task naming another workspace", async () => {
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input({ workspaceId: 'ws-b' }), quietLog)).toEqual({ written: false, reason: 'not_found' });
    await expectUntouched(writes);
  });

  it('writes nothing (and resurrects no Firestore doc) for a note deleted mid-run', async () => {
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'note-a'`);
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input(), quietLog)).toEqual({ written: false, reason: 'not_found' });
    await expectUntouched(writes);
  });

  // The summarizer checks the task's generation before the Gemini call, which
  // can take minutes. A regenerate claimed in that window bumps the generation.
  // The older run must then write nothing, or it would put its (older-template)
  // summary over the newer run's and mark the note ready while that run is live.
  it('writes nothing for a run a newer generation superseded mid-call', async () => {
    await pool.query(`UPDATE notes SET summary_generation = summary_generation + 1 WHERE id = 'note-a'`);
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input({ expectedGeneration: 0 }), quietLog)).toEqual({ written: false, reason: 'superseded' });
    await expectUntouched(writes);
    // ...and the run that owns generation 1 still lands.
    expect(await markSummaryReady(fs, input({ expectedGeneration: 1 }), quietLog)).toEqual({ written: true });
  });

  // Deleted (POST /v1/notes/delete) between this write's commit and its
  // mirror: the doc is gone, and must stay gone. No "ready" push either.
  it("doesn't re-create the doc of a note deleted between the commit and the mirror", async () => {
    const { fs } = fsStub({ missing: true, deleteNoteFirst: true });
    expect(await markSummaryReady(fs, input(), quietLog)).toEqual({ written: false, reason: 'not_found' });
  });

  // NOT_FOUND also means a wrong project/database. A note still live in
  // Postgres must fail loudly (the summarizer retries, then dead-letters).
  it('throws when the doc is missing but the note is still live in Postgres', async () => {
    const { fs } = fsStub({ missing: true });
    await expect(markSummaryReady(fs, input(), quietLog)).rejects.toThrow(/NOT_FOUND/);
  });
});
