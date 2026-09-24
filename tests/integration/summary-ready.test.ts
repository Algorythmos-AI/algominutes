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

function fsStub() {
  const writes: Array<{ path: string; data: any }> = [];
  return { fs: { doc: (path: string) => ({ set: async (data: any) => void writes.push({ path, data }) }) } as never, writes };
}
const input = (over: Record<string, unknown> = {}) => ({
  noteId: 'note-a',
  workspaceId: 'ws-a',
  summary: { gist: 'We agreed to ship.', actionItems: ['Ship it', 'Tell sales'], keyDecisions: ['Ship Friday'] },
  model: 'gemini-3.5-flash',
  transcriptPreview: [{ speaker: 'Alice', text: 'hi', time: '00:01' }],
  transcriptTruncated: false,
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
    expect(writes).toEqual([{ path: 'workspaces/ws-a/notes/note-a', data: expect.objectContaining({ status: 'ready' }) }]);
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
    expect((await pool.query(`SELECT status FROM notes WHERE id = 'note-a'`)).rows[0].status).toBe('summarizing');
  };

  it("writes nothing, anywhere, for a task naming another workspace", async () => {
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input({ workspaceId: 'ws-b' }), quietLog)).toEqual({ written: false });
    await expectUntouched(writes);
  });

  it('writes nothing (and resurrects no Firestore doc) for a note deleted mid-run', async () => {
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'note-a'`);
    const { fs, writes } = fsStub();
    expect(await markSummaryReady(fs, input(), quietLog)).toEqual({ written: false });
    await expectUntouched(writes);
  });
});
