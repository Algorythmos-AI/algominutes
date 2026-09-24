import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, setNoteSpeakers, getNoteSpeakers, markReady } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

// CLAUDE.md §1 Multi-tenancy: a user in workspace A must never read or write
// workspace B's data. Two users, two workspaces, one note each.
beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
  await seedWorkspace('ws-b', 'bob');
  await seedNote('note-a', 'ws-a', 'alice');
  await seedNote('note-b', 'ws-b', 'bob');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function isMember(workspaceId: string, uid: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND uid = $2',
    [workspaceId, uid],
  );
  return rows.length > 0;
}

describe('note speakers (note-speakers-repo)', () => {
  it('a member can rename speakers on their own note', async () => {
    expect(await setNoteSpeakers('alice', 'note-a', [{ speakerTag: 1, name: 'Alice' }])).toEqual([1]);
    expect(await getNoteSpeakers('alice', 'note-a')).toEqual([{ speakerTag: 1, name: 'Alice' }]);
  });

  it("a non-member can neither write nor read another workspace's speakers", async () => {
    await setNoteSpeakers('alice', 'note-a', [{ speakerTag: 1, name: 'Alice' }]);
    expect(await setNoteSpeakers('bob', 'note-a', [{ speakerTag: 1, name: 'Mallory' }])).toEqual([]);
    expect(await getNoteSpeakers('bob', 'note-a')).toEqual([]);
    expect(await getNoteSpeakers('alice', 'note-a')).toEqual([{ speakerTag: 1, name: 'Alice' }]);
  });
});

describe('markReady (notes-repo) — KNOWN BUG, pinned', () => {
  // upsertCoreToPostgres inserts (workspaceId, authorUid) into
  // workspace_members as 'owner' with ON CONFLICT DO NOTHING, without checking
  // that the author already belongs to that workspace. A worker payload with a
  // mismatched pair silently makes the author an OWNER of someone else's
  // workspace. `it.fails` documents the current behaviour; the fix PR flips it
  // to a plain `it` (and this line becomes its evidence).
  it.fails('never grants membership in an existing workspace the author does not belong to', async () => {
    const firestore = { doc: () => ({ update: async () => undefined }) } as never;
    await markReady(
      firestore,
      {
        noteId: 'note-x',
        workspaceId: 'ws-b',
        authorUid: 'alice',
        sourceType: 'recording',
        summary: { gist: 'g', actionItems: [], keyDecisions: [] },
        transcript: [],
      },
      quietLog,
    );
    expect(await isMember('ws-b', 'alice')).toBe(false);
  });
});
