import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, setNoteSpeakers, getNoteSpeakers, markReady, markError, applyNoteEdit } from '@algominutes/db';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog } from './helpers';

const { markNoteFailed } = createRequire(import.meta.url)('@algominutes/ai/note-terminal.cjs');

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

function firestoreStub() {
  const updates: unknown[] = [];
  const fs = { doc: () => ({ update: async (data: unknown) => void updates.push(data) }) } as never;
  return { fs, updates };
}

const readyInput = (over: Partial<Parameters<typeof markReady>[1]> = {}) => ({
  noteId: 'note-a',
  workspaceId: 'ws-a',
  authorUid: 'alice',
  sourceType: 'recording',
  summary: { gist: 'the gist', actionItems: ['ship it'], keyDecisions: [] },
  transcript: [{ speaker: 'Alice', text: 'hello', time: '00:01' }],
  ...over,
});

async function noteRow(id: string) {
  const { rows } = await pool.query('SELECT workspace_id, status, title FROM notes WHERE id = $1', [id]);
  return rows[0];
}

describe('markReady (notes-repo)', () => {
  it('writes the note, summary and transcript for a member of the workspace', async () => {
    const { fs, updates } = firestoreStub();
    const out = await markReady(fs, readyInput(), quietLog);
    expect(out.pgWritten).toBe(true);
    expect((await noteRow('note-a')).status).toBe('ready');
    const { rows } = await pool.query(`SELECT gist FROM summaries WHERE note_id = 'note-a'`);
    expect(rows[0].gist).toBe('the gist');
    expect(updates).toHaveLength(1);
  });

  it('bootstraps a brand-new workspace with the author as its owner', async () => {
    const { fs } = firestoreStub();
    await markReady(fs, readyInput({ noteId: 'note-new', workspaceId: 'ws-new' }), quietLog);
    expect(await isMember('ws-new', 'alice')).toBe(true);
  });

  // Regression for the escalation pinned by the harness PR: this was it.fails.
  it('never grants membership in an existing workspace the author does not belong to', async () => {
    const { fs, updates } = firestoreStub();
    await expect(
      markReady(fs, readyInput({ noteId: 'note-x', workspaceId: 'ws-b' }), quietLog),
    ).rejects.toThrow(/not a member of workspace ws-b/);
    expect(await isMember('ws-b', 'alice')).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it("never overwrites a note that lives in another workspace", async () => {
    const { fs } = firestoreStub();
    await expect(
      markReady(fs, readyInput({ noteId: 'note-b', workspaceId: 'ws-a' }), quietLog),
    ).rejects.toThrow(/belongs to a different workspace/);
    const b = await noteRow('note-b');
    expect(b.workspace_id).toBe('ws-b');
    expect(b.status).toBe('queued');
    const { rows } = await pool.query(`SELECT 1 FROM summaries WHERE note_id = 'note-b'`);
    expect(rows).toHaveLength(0);
  });

  it('does not mark the Firestore cache ready when the Postgres write fails', async () => {
    const { fs, updates } = firestoreStub();
    // source_type is NOT NULL: a brand-new note without one fails in Postgres.
    await expect(
      markReady(fs, readyInput({ noteId: 'note-bad', sourceType: null as never }), quietLog),
    ).rejects.toThrow();
    expect(updates).toHaveLength(0);
    expect(await noteRow('note-bad')).toBeUndefined();
  });
});

describe('applyNoteEdit (notes-repo)', () => {
  it("edits a note in the caller's own workspace", async () => {
    const { fs } = firestoreStub();
    const out = await applyNoteEdit(fs, { noteId: 'note-a', workspaceId: 'ws-a', title: 'Renamed' }, quietLog);
    expect(out.pgWritten).toBe(true);
    expect((await noteRow('note-a')).title).toBe('Renamed');
  });

  it("cannot edit another workspace's note, even given its id", async () => {
    const { fs } = firestoreStub();
    const out = await applyNoteEdit(fs, { noteId: 'note-b', workspaceId: 'ws-a', title: 'Hijacked' }, quietLog);
    expect(out.pgWritten).toBe(false);
    expect((await noteRow('note-b')).title).not.toBe('Hijacked');
  });
});

describe('markError (notes-repo)', () => {
  it("marks the caller's own note errored", async () => {
    const { fs } = firestoreStub();
    await markError(fs, { noteId: 'note-a', workspaceId: 'ws-a', errorMessage: 'boom' }, quietLog);
    expect((await noteRow('note-a')).status).toBe('error');
  });

  it("cannot mark another workspace's note errored", async () => {
    const { fs } = firestoreStub();
    await markError(fs, { noteId: 'note-b', workspaceId: 'ws-a', errorMessage: 'boom' }, quietLog);
    expect((await noteRow('note-b')).status).toBe('queued');
  });
});

describe('markNoteFailed (packages/ai note-terminal) — terminal-failure writer', () => {
  let sets: string[] = [];
  const fsStub = { doc: (path: string) => ({ set: async () => void sets.push(path) }) };
  beforeEach(() => {
    sets = [];
  });

  it("marks the payload's own note errored", async () => {
    await markNoteFailed({ pool, firestore: fsStub, noteId: 'note-a', workspaceId: 'ws-a', message: 'x', log: quietLog });
    expect((await noteRow('note-a')).status).toBe('error');
  });

  it('cannot mark a note in a different workspace errored', async () => {
    await markNoteFailed({ pool, firestore: fsStub, noteId: 'note-b', workspaceId: 'ws-a', message: 'x', log: quietLog });
    expect((await noteRow('note-b')).status).toBe('queued');
  });

  it('mirrors the failure to Firestore when Postgres marked it', async () => {
    await markNoteFailed({ pool, firestore: fsStub, noteId: 'note-a', workspaceId: 'ws-a', message: 'x', log: quietLog });
    expect(sets).toEqual(['workspaces/ws-a/notes/note-a']);
  });

  it('writes no phantom Firestore doc for a note in another workspace', async () => {
    await markNoteFailed({ pool, firestore: fsStub, noteId: 'note-b', workspaceId: 'ws-a', message: 'x', log: quietLog });
    expect(sets).toEqual([]);
  });

  it("never contradicts Postgres: an already-ready note is not mirrored as 'error'", async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'note-a'`);
    await markNoteFailed({ pool, firestore: fsStub, noteId: 'note-a', workspaceId: 'ws-a', message: 'x', log: quietLog });
    expect((await noteRow('note-a')).status).toBe('ready');
    expect(sets).toEqual([]);
  });
});
