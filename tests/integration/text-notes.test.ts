import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// Plan rev 12 R12.8 PR 2 (S16): a text note (a scan, a PDF, an imported file) written to Postgres first, like every
// other note, then mirrored to Firestore. The iPhone used to write it straight into Firestore, so Postgres never
// had it: outside retention, backups, search, chat and export.
const { createTextNote, getPool } = repo as any;

// A Firestore stand-in with create/update/get, the calls the repo makes.
const docs = new Map<string, Record<string, any>>();
// Run before a create() lands: a test can fail it, or delete the note meanwhile.
let beforeCreate: (() => Promise<void>) | null = null;
// Fail the next delete() (a Firestore outage while the doc is taken back out).
let failDelete = false;
const firestore: any = {
  doc: (path: string) => ({
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async create(v: Record<string, unknown>) {
      if (beforeCreate) { const hook = beforeCreate; beforeCreate = null; await hook(); }
      if (docs.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
      docs.set(path, { ...v });
    },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() {
      if (failDelete) { failDelete = false; throw new Error('14 UNAVAILABLE'); }
      docs.delete(path);
    },
  }),
};
const doc = (ws: string, id: string) => docs.get(`workspaces/${ws}/notes/${id}`);

beforeEach(async () => {
  await resetDb();
  docs.clear();
  beforeCreate = null;
  failDelete = false;
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const make = (over: Record<string, unknown> = {}) => createTextNote(firestore, {
  uid: 'alice', workspaceId: 'workspace_alice', noteId: 't1', source: 'scanned_image',
  text: 'Receipt from the cafe\n\nCoffee 4.50\n\nTotal 4.50', traceId: 'tr-1', ...over,
}, quietLog);

describe('createTextNote', () => {
  it('writes the note, its lines and its summary to Postgres, ready, then the Firestore doc', async () => {
    const r = await make();
    expect(r).toEqual({ noteId: 't1', status: 'ready', lines: 3, truncated: false, replay: false });
    const { rows: [n] } = await pool.query(`SELECT status, source_type, title, word_count, duration_sec, author_uid FROM notes WHERE id = 't1'`);
    expect(n).toEqual({ status: 'ready', source_type: 'scan_text', title: 'Receipt from the cafe', word_count: 8, duration_sec: 0, author_uid: 'alice' });
    const { rows: lines } = await pool.query(`SELECT idx, speaker_name, text, start_ms, end_ms, chunk_id FROM transcript_lines WHERE note_id = 't1' ORDER BY idx`);
    expect(lines.map((l) => [l.idx, l.text])).toEqual([[0, 'Receipt from the cafe'], [1, 'Coffee 4.50'], [2, 'Total 4.50']]);
    expect(lines.every((l) => l.speaker_name === 'Scanned image' && l.start_ms === 0 && l.end_ms === 0 && l.chunk_id === null)).toBe(true);
    const { rows: [s] } = await pool.query(`SELECT gist FROM summaries WHERE note_id = 't1'`);
    expect(s.gist.startsWith('Scanned image - 8 words extracted.')).toBe(true);
    // The doc the iPhone's note screen reads, as it wrote it itself.
    expect(doc('workspace_alice', 't1')).toMatchObject({
      title: 'Receipt from the cafe', status: 'ready', type: 'scan_text', duration: 0, wordCount: 8, transcriptTruncated: false,
      rawText: 'Receipt from the cafe\n\nCoffee 4.50\n\nTotal 4.50', workspaceId: 'workspace_alice', authorId: 'alice',
      summary: { gist: s.gist, actionItems: [], keyDecisions: [] },
    });
    expect(doc('workspace_alice', 't1')!.transcript).toEqual([
      { speaker: 'Scanned image', text: 'Receipt from the cafe', time: '' },
      { speaker: 'Scanned image', text: 'Coffee 4.50', time: '' },
      { speaker: 'Scanned image', text: 'Total 4.50', time: '' },
    ]);
  });

  // From the dual-write audit: a replay rewrites nothing, so a late retry can't undo an edit made since.
  it('a replay is the same note: answered ready, nothing rewritten in either store', async () => {
    await make();
    await pool.query(`UPDATE notes SET title = 'Edited' WHERE id = 't1'`);
    docs.get('workspaces/workspace_alice/notes/t1')!.title = 'Edited';
    const r = await make({ text: 'Something else entirely' });
    expect(r).toMatchObject({ noteId: 't1', status: 'ready', replay: true });
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 't1'`)).toBe(3);
    expect((await pool.query(`SELECT title FROM notes WHERE id = 't1'`)).rows[0].title).toBe('Edited');
    expect(doc('workspace_alice', 't1')!.title).toBe('Edited');
    expect(doc('workspace_alice', 't1')!.transcript).toHaveLength(3);
  });

  it('committed in Postgres but the doc write failed: the retry writes the doc', async () => {
    beforeCreate = async () => { throw new Error('14 UNAVAILABLE'); };
    await expect(make()).rejects.toThrow(/UNAVAILABLE/);
    expect(await count(`SELECT 1 FROM notes WHERE id = 't1'`)).toBe(1);
    expect(doc('workspace_alice', 't1')).toBeUndefined();
    const r = await make();
    expect(r).toMatchObject({ replay: true });
    expect(doc('workspace_alice', 't1')).toMatchObject({ status: 'ready', type: 'scan_text' });
  });

  // From the second audit: the doc a retry writes is the stored note, not the retry's input (which can differ: other
  // text, another day's dated title, a later time).
  it("a retry after a failed doc write mirrors what Postgres holds, not the retry's input", async () => {
    beforeCreate = async () => { throw new Error('14 UNAVAILABLE'); };
    await expect(make({ text: 'ok', createdAt: new Date('2026-10-01T23:59:00Z') })).rejects.toThrow(/UNAVAILABLE/);
    await pool.query(`UPDATE notes SET title = 'Edited' WHERE id = 't1'`);
    const r = await make({ text: 'Something else entirely\n\nand more', createdAt: new Date('2026-10-02T00:01:00Z') });
    expect(r).toMatchObject({ replay: true, lines: 1, truncated: false });
    const d = doc('workspace_alice', 't1')!;
    expect(d).toMatchObject({ title: 'Edited', wordCount: 1, createdAt: '2026-10-01T23:59:00.000Z', rawText: 'ok' });
    expect(d.transcript).toEqual([{ speaker: 'Scanned image', text: 'ok', time: '' }]);
    const gist = (await pool.query(`SELECT gist FROM summaries WHERE note_id = 't1'`)).rows[0].gist;
    expect(d.summary.gist).toBe(gist);
  });

  it('two at once: the second finds the doc the first wrote, and both answer ready', async () => {
    const [a, b] = await Promise.all([make(), make()]);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    expect(await count(`SELECT 1 FROM notes WHERE id = 't1'`)).toBe(1);
    expect(doc('workspace_alice', 't1')).toBeDefined();
  });

  // From the dual-write audit: a note deleted between the commit and the doc would get its doc back, with nothing to
  // remove it (the delete's purge may already have run).
  it('deleted between the commit and the doc: the doc is taken back out, and the note is refused', async () => {
    beforeCreate = async () => {
      await repo.deleteNote(firestore, { noteId: 't1', workspaceId: 'workspace_alice', uid: 'alice', traceId: 'tr' }, quietLog);
    };
    await expect(make()).rejects.toMatchObject({ code: 'NOTE_DELETED' });
    expect(doc('workspace_alice', 't1')).toBeUndefined();
    expect(await count(`SELECT 1 FROM notes WHERE id = 't1'`)).toBe(0);
  });

  // From the second audit: when taking the doc back out fails, the retry is refused in Postgres before any
  // Firestore call, so it must still remove the doc.
  it('deleted in between, and taking the doc out failed: the retry removes it', async () => {
    beforeCreate = async () => {
      await repo.deleteNote(firestore, { noteId: 't1', workspaceId: 'workspace_alice', uid: 'alice', traceId: 'tr' }, quietLog);
      failDelete = true;
    };
    await expect(make()).rejects.toThrow(/UNAVAILABLE/);
    expect(doc('workspace_alice', 't1')).toBeDefined();
    await expect(make()).rejects.toMatchObject({ code: 'NOTE_DELETED' });
    expect(doc('workspace_alice', 't1')).toBeUndefined();
  });

  it('the fallback title is the same in Postgres and the doc', async () => {
    await make({ text: 'ok' });
    const pg = (await pool.query(`SELECT title FROM notes WHERE id = 't1'`)).rows[0].title;
    expect(pg).toMatch(/^Import \d{4}-\d{2}-\d{2}$/);
    expect(doc('workspace_alice', 't1')!.title).toBe(pg);
  });

  it('mirrors at most 200 lines to Firestore, and keeps every line in Postgres', async () => {
    const text = Array.from({ length: 250 }, (_, i) => `Paragraph ${i}`).join('\n');
    await make({ text });
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 't1'`)).toBe(250);
    expect(doc('workspace_alice', 't1')!.transcript).toHaveLength(200);
    // The iPhone reads this as "the mirror is a preview: fetch the rest" (NoteDetailView), as for every note.
    expect(doc('workspace_alice', 't1')!.transcriptTruncated).toBe(true);
  });

  it('a text cut at the limit, with every line mirrored, is no preview', async () => {
    const r = await make({ text: 'x'.repeat(200_000) });
    expect(r.truncated).toBe(true);
    expect(doc('workspace_alice', 't1')!.transcriptTruncated).toBe(false);
    expect(doc('workspace_alice', 't1')!.rawText).toMatch(/\[Text truncated for mobile display\.\]$/);
  });

  // A doc over Firestore's 1 MiB would fail its create() on every retry: a long text in a script of 3-byte
  // characters is 540 KB as rawText and as much again as lines.
  it("keeps the doc under Firestore's size limit: a long text's rawText stays in Postgres only", async () => {
    const text = Array.from({ length: 150 }, () => '\u6f22'.repeat(1_000)).join('\n');
    await make({ text });
    const d = doc('workspace_alice', 't1')!;
    expect(d.rawText).toBeUndefined();
    expect(d.transcript).toHaveLength(150);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThan(1_000_000);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 't1'`)).toBe(150);
  });

  // Every transcript read orders by (start_ms, id), and a text note's lines all start at 0: their ids must follow
  // the paragraphs.
  it('stores the lines so that every transcript read gets the paragraphs in order', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}`).join('\n');
    await make({ text });
    const { rows } = await pool.query(`SELECT idx, text FROM transcript_lines WHERE note_id = 't1' ORDER BY start_ms, id`);
    expect(rows.map((r) => r.idx)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  // The caller enqueues the embedding; claimed with the note, so a lost enqueue is re-driven by the sweep
  // (claimLostEmbeds), as for every note.
  it('is claimed for embedding with the note, so the sweep re-drives an embed that was lost', async () => {
    await make();
    const at = (await pool.query(`SELECT embedder_enqueued_at FROM notes WHERE id = 't1'`)).rows[0].embedder_enqueued_at;
    expect(at).not.toBeNull();
    await make();
    expect((await pool.query(`SELECT embedder_enqueued_at FROM notes WHERE id = 't1'`)).rows[0].embedder_enqueued_at).toEqual(at);
    await pool.query(`UPDATE notes SET embedder_enqueued_at = NOW() - INTERVAL '2 hours' WHERE id = 't1'`);
    const lost = await repo.claimLostEmbeds({ olderThanMs: 90 * 60_000, withinMs: 6 * 3_600_000, limit: 10 });
    expect(lost).toEqual([expect.objectContaining({ noteId: 't1', workspaceId: 'workspace_alice', uid: 'alice' })]);
  });

  it("takes the app's title when the text has none of its own", async () => {
    await make({ text: 'ok', title: 'Lease.pdf' });
    const { rows: [n] } = await pool.query(`SELECT title FROM notes WHERE id = 't1'`);
    expect(n.title).toBe('Lease.pdf');
  });

  it('a deleted account is refused, and nothing is written', async () => {
    await pool.query(`INSERT INTO account_deletions (uid) VALUES ('alice')`);
    await expect(make()).rejects.toMatchObject({ code: 'ACCOUNT_DELETED' });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
    expect(docs.size).toBe(0);
  });

  it('a deleted note id is refused: a stale client cannot bring it back', async () => {
    await pool.query(`INSERT INTO deleted_notes (note_id, workspace_id) VALUES ('t1', 'workspace_alice')`);
    await expect(make()).rejects.toMatchObject({ code: 'NOTE_DELETED' });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  it("another kind of note's id is refused, never overwritten", async () => {
    await seedNote('t1', 'workspace_alice', 'alice');
    const before = (await pool.query(`SELECT source_type, status FROM notes WHERE id = 't1'`)).rows[0];
    await expect(make()).rejects.toMatchObject({ code: 'TEXT_NOTE_CONFLICT' });
    expect((await pool.query(`SELECT source_type, status FROM notes WHERE id = 't1'`)).rows[0]).toEqual(before);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 't1'`)).toBe(0);
  });

  // CLAUDE.md §1: a user in workspace A must never write into workspace B.
  it("another account can't write into this workspace, or take this note's id from its own", async () => {
    await seedUser('bob');
    await seedWorkspace('workspace_bob', 'bob');
    await expect(make({ uid: 'bob' })).rejects.toMatchObject({ code: 'WORKSPACE_BOUNDARY' });
    await make();
    await expect(make({ uid: 'bob', workspaceId: 'workspace_bob' })).rejects.toMatchObject({ code: 'TEXT_NOTE_CONFLICT' });
    expect((await pool.query(`SELECT workspace_id, author_uid FROM notes WHERE id = 't1'`)).rows[0]).toEqual({ workspace_id: 'workspace_alice', author_uid: 'alice' });
  });

  it("a first-ever request makes the user and the personal workspace, as admission does", async () => {
    await createTextNote(firestore, { uid: 'carol', email: 'c@test.invalid', workspaceId: 'workspace_carol', noteId: 'c1', source: 'pdf', text: 'Hello there' }, quietLog);
    expect(await count(`SELECT 1 FROM workspace_members WHERE workspace_id = 'workspace_carol' AND uid = 'carol' AND role = 'owner'`)).toBe(1);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'c1' AND source_type = 'scan_text'`)).toBe(1);
  });

  // The reason for S16: a text note in Postgres is under the user's retention, like every other note.
  it("is found by retention once it's older than the user's setting", async () => {
    await make({ createdAt: new Date(Date.now() - 40 * 86_400_000) });
    await pool.query(`UPDATE users SET retention_days = 30 WHERE uid = 'alice'`);
    const due = await repo.listNotesPastRetention({});
    expect(due.map((n: any) => n.noteId)).toEqual(['t1']);
  });

  it('is deleted with the note, like every other note', async () => {
    await make();
    const r = await repo.deleteNote(firestore, { noteId: 't1', workspaceId: 'workspace_alice', uid: 'alice', traceId: 'tr' }, quietLog);
    expect(r.allowed).toBe(true);
    expect(await count(`SELECT 1 FROM notes WHERE id = 't1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 't1'`)).toBe(0);
    expect(await count(`SELECT 1 FROM summaries WHERE note_id = 't1'`)).toBe(0);
  });
});
