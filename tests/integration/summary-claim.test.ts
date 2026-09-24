import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, claimSummaryRegeneration, releaseSummaryClaim, mirrorSummarizing, markSummaryReady } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

// POST /v1/notes/regenerate-summary. The claim used to be inline SQL in the api
// route (plus a direct Firestore write and an unscoped rollback UPDATE); it now
// lives in the repo layer. These pin its semantics.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob');
  await seedNote('note-a', 'ws-a', 'alice');
  await seedNote('note-b', 'ws-b', 'bob');
  await pool.query(`UPDATE notes SET status = 'ready', summary_generation = 3`);
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const note = async (id: string) =>
  (await pool.query('SELECT status, summary_generation, summary_template FROM notes WHERE id = $1', [id])).rows[0];

describe('summary regeneration claim (notes-repo)', () => {
  it('claims a ready note: bumps the generation, sets the template, marks summarizing', async () => {
    expect(await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a', template: 'standup' }))
      .toEqual({ claimed: true, generation: 4, template: 'standup' });
    expect(await note('note-a')).toEqual({ status: 'summarizing', summary_generation: 4, summary_template: 'standup' });
  });

  it('a double tap is refused while a run is fresh; a stuck run (>15 min) is taken over', async () => {
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' });
    expect(await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }))
      .toEqual({ claimed: false, reason: 'already_regenerating', status: 'summarizing' });
    await pool.query(`UPDATE notes SET summary_requested_at = NOW() - INTERVAL '16 minutes' WHERE id = 'note-a'`);
    expect((await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' })).claimed).toBe(true);
  });

  it('manual edits block the claim until the caller confirms overwriting them', async () => {
    await pool.query(`UPDATE notes SET summary_manually_edited_at = '2026-09-20T10:00:00Z' WHERE id = 'note-a'`);
    expect(await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }))
      .toEqual({ claimed: false, reason: 'manual_edits_present', editedAt: '2026-09-20T10:00:00.000Z' });
    expect((await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a', confirmOverwrite: true })).claimed).toBe(true);
  });

  it("cannot claim another workspace's note, or a deleted one (not found)", async () => {
    expect(await claimSummaryRegeneration({ noteId: 'note-b', workspaceId: 'ws-a' })).toEqual({ claimed: false, reason: 'not_found' });
    expect((await note('note-b')).status).toBe('ready');
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'note-a'`);
    expect(await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' })).toEqual({ claimed: false, reason: 'not_found' });
  });

  it("release hands the note back and undoes the generation bump; it cannot touch another workspace's note", async () => {
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' });
    await claimSummaryRegeneration({ noteId: 'note-b', workspaceId: 'ws-b' });
    await releaseSummaryClaim({ noteId: 'note-b', workspaceId: 'ws-a', generation: 4 }); // wrong workspace: no-op
    expect(await note('note-b')).toMatchObject({ status: 'summarizing', summary_generation: 4 });
    await releaseSummaryClaim({ noteId: 'note-a', workspaceId: 'ws-a', generation: 4 });
    expect(await note('note-a')).toMatchObject({ status: 'ready', summary_generation: 3 });
  });

  it('release is a no-op for a generation it did not mint (a later claim owns the note)', async () => {
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }); // 4
    await pool.query(`UPDATE notes SET summary_requested_at = NOW() - INTERVAL '16 minutes' WHERE id = 'note-a'`);
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }); // 5 (stale-lock takeover)
    await releaseSummaryClaim({ noteId: 'note-a', workspaceId: 'ws-a', generation: 4 });
    expect(await note('note-a')).toMatchObject({ status: 'summarizing', summary_generation: 5 });
  });

  // A stale-lock takeover whose enqueue then fails: the run from before the
  // takeover is still in flight at the old generation. Releasing the failed
  // claim must let that run land, not leave it superseded by a generation no
  // task carries.
  it('after a failed takeover is released, the run still in flight lands its summary', async () => {
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }); // run A reads 4
    await pool.query(`UPDATE notes SET summary_requested_at = NOW() - INTERVAL '16 minutes' WHERE id = 'note-a'`);
    await claimSummaryRegeneration({ noteId: 'note-a', workspaceId: 'ws-a' }); // takeover: 5
    await releaseSummaryClaim({ noteId: 'note-a', workspaceId: 'ws-a', generation: 5 }); // enqueue failed
    const fs = { doc: () => ({ set: async () => undefined }) } as never;
    const landed = await markSummaryReady(fs, {
      noteId: 'note-a', workspaceId: 'ws-a', expectedGeneration: 4,
      summary: { gist: 'A', actionItems: [], keyDecisions: [] },
      transcriptPreview: [], transcriptTruncated: false,
    }, quietLog);
    expect(landed).toEqual({ written: true });
    expect(await note('note-a')).toMatchObject({ status: 'ready', summary_generation: 4 });
  });

  it("mirrors 'summarizing' to the note's Firestore doc", async () => {
    const writes: Array<{ path: string; data: any; opts: any }> = [];
    const fs = { doc: (path: string) => ({ set: async (data: any, opts: any) => void writes.push({ path, data, opts }) }) } as never;
    await mirrorSummarizing(fs, { noteId: 'note-a', workspaceId: 'ws-a' });
    expect(writes).toEqual([{ path: 'workspaces/ws-a/notes/note-a', data: expect.objectContaining({ status: 'summarizing' }), opts: { merge: true } }]);
  });
});
