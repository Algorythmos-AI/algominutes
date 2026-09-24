import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getPool, setNoteSpeakers, getNoteSpeakers, markReady, markError, markQueued, applyNoteEdit, WorkspaceBoundaryError,
} from '@algominutes/db';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, count } from './helpers';

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

  it("heals the owner's missing membership instead of refusing them (shared helper)", async () => {
    const { fs } = firestoreStub();
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = 'ws-a' AND uid = 'alice'`);
    await markReady(fs, readyInput(), quietLog);
    expect(await isMember('ws-a', 'alice')).toBe(true);
    expect((await noteRow('note-a')).status).toBe('ready');
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

// Firestore stub that also records set() (markQueued mirrors with set/merge).
function firestoreSetStub() {
  const writes: Array<{ path: string; data: unknown }> = [];
  const fs = {
    doc: (path: string) => ({
      set: async (data: unknown) => void writes.push({ path, data }),
      update: async (data: unknown) => void writes.push({ path, data }),
    }),
  } as never;
  return { fs, writes };
}

async function seedChunks(noteId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status)
         VALUES ($1, $2, $3, $4, $5, 'done')`,
      [noteId, i, i * 600, (i + 1) * 600, `${noteId}/chunks/${i}.flac`],
    );
  }
}

const queuedInput = (over: Partial<Parameters<typeof markQueued>[1]> = {}) => ({
  noteId: 'note-a',
  workspaceId: 'ws-a',
  authorUid: 'alice',
  sourceType: 'recording',
  storagePath: 'ws-a/audio/meeting.m4a',
  mimeType: 'audio/mp4',
  ...over,
});

// POST /v1/process. Postgres note ids are GLOBAL while Firestore ids are
// per-workspace, so a caller can present another tenant's note id from inside
// their own workspace. This SQL used to live in the api route with no guard.
describe('markQueued (notes-repo): POST /v1/process', () => {
  it("queues the caller's own note, resets the run, and mirrors 'queued'", async () => {
    await pool.query(`UPDATE notes SET status = 'error', chunks_done = 7, error_message = 'old' WHERE id = 'note-a'`);
    await seedChunks('note-a', 2);
    const { fs, writes } = firestoreSetStub();
    await markQueued(fs, queuedInput(), quietLog);
    const { rows } = await pool.query(
      `SELECT workspace_id, status, storage_path, chunks_done, error_message FROM notes WHERE id = 'note-a'`,
    );
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-a', status: 'queued', storage_path: 'ws-a/audio/meeting.m4a', chunks_done: 0, error_message: null,
    });
    expect(await count(`SELECT 1 FROM audio_chunks WHERE note_id = 'note-a'`)).toBe(0);
    expect(writes).toEqual([{ path: 'workspaces/ws-a/notes/note-a', data: expect.objectContaining({ status: 'queued' }) }]);
  });

  it("cannot reset, re-point, or delete the chunks of another workspace's note", async () => {
    await pool.query(
      `UPDATE notes SET status = 'ready', storage_path = 'ws-a/audio/meeting.m4a', chunks_done = 12, chunks_total = 12
        WHERE id = 'note-a'`,
    );
    await seedChunks('note-a', 2);
    const { fs, writes } = firestoreSetStub();
    // bob, from his OWN workspace, presents alice's note id with his own audio.
    await expect(
      markQueued(fs, queuedInput({ workspaceId: 'ws-b', authorUid: 'bob', storagePath: 'ws-b/audio/attacker.m4a' }), quietLog),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    const { rows } = await pool.query(
      `SELECT workspace_id, status, storage_path, chunks_done, chunks_total FROM notes WHERE id = 'note-a'`,
    );
    expect(rows[0]).toEqual({
      workspace_id: 'ws-a', status: 'ready', storage_path: 'ws-a/audio/meeting.m4a', chunks_done: 12, chunks_total: 12,
    });
    expect(await count(`SELECT 1 FROM audio_chunks WHERE note_id = 'note-a'`)).toBe(2);
    expect(writes).toEqual([]);
  });

  it('never makes the caller a member of an existing workspace they do not own', async () => {
    const { fs } = firestoreSetStub();
    await expect(
      markQueued(fs, queuedInput({ noteId: 'note-new', workspaceId: 'ws-a', authorUid: 'bob' }), quietLog),
    ).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect(await isMember('ws-a', 'bob')).toBe(false);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'note-new'`)).toBe(0);
  });

  it('queues for a caller with no email claim (anonymous sign-in) without clobbering a real email', async () => {
    const { fs } = firestoreSetStub();
    await markQueued(fs, queuedInput({ noteId: 'note-anon', workspaceId: 'ws-anon', authorUid: 'anon' }), quietLog);
    expect((await pool.query(`SELECT email FROM users WHERE uid = 'anon'`)).rows[0].email).toBe('anon@firebase.local');

    await markQueued(fs, queuedInput({ authorEmail: 'alice@real.example' }), quietLog);
    await markQueued(fs, queuedInput(), quietLog); // a later call without the claim
    expect((await pool.query(`SELECT email FROM users WHERE uid = 'alice'`)).rows[0].email).toBe('alice@real.example');
  });

  it("bootstraps a brand-new user's workspace, and heals an owner's missing membership", async () => {
    const { fs } = firestoreSetStub();
    await markQueued(fs, queuedInput({ noteId: 'note-c', workspaceId: 'ws-carol', authorUid: 'carol' }), quietLog);
    expect(await isMember('ws-carol', 'carol')).toBe(true);

    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = 'ws-b' AND uid = 'bob'`);
    await markQueued(fs, queuedInput({ noteId: 'note-b2', workspaceId: 'ws-b', authorUid: 'bob' }), quietLog);
    expect(await isMember('ws-b', 'bob')).toBe(true);
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
