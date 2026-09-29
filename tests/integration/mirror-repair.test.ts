import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The sweep's mirror repair: a note Postgres finished whose Firestore doc
// missed its mirror write is brought in line, content included, but never over
// a newer write (a lastUpdateTime precondition), never over a doc written in
// the last 10 minutes (a client's Retry), and never for a note Postgres doesn't
// call finished. Real Postgres; the Firestore fake honours update-time
// preconditions.
const require = createRequire(import.meta.url);
const sweep = require('../../services/db-job/src/handlers/sweep.js');
const noteTerminal = require('@algominutes/db/note-terminal.cjs');
const { listRecentlyFinishedNotes, repairNoteMirror } = repo;

const MIN = 60_000;
const ts = (ms: number) => ({ ms, toMillis: () => ms });
const docs = new Map<string, { data: any; updateTime: { ms: number; toMillis: () => number } }>();
let beforeUpdate: (() => void) | null = null;
const DOC = 'workspaces/ws/notes/n1';
const firestore: any = {
  doc: (p: string) => ({
    get: async () => {
      const d = docs.get(p);
      return { exists: !!d, data: () => d && JSON.parse(JSON.stringify(d.data)), updateTime: d?.updateTime };
    },
    update: async (patch: Record<string, unknown>, pre?: { lastUpdateTime?: number }) => {
      beforeUpdate?.();
      const d = docs.get(p);
      if (!d) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 });
      if (pre && pre.lastUpdateTime !== undefined && (pre.lastUpdateTime as any).ms !== d.updateTime.ms) {
        throw Object.assign(new Error('9 FAILED_PRECONDITION'), { code: 9 });
      }
      for (const [k, v] of Object.entries(patch)) {
        if (k.includes('.')) { const [a, b] = k.split('.'); d.data[a] = { ...(d.data[a] || {}), [b]: v }; } else d.data[k] = v;
      }
      d.updateTime = ts(d.updateTime.ms + 1);
    },
  }),
};
// Last written 20 minutes ago, unless `agoMs` says otherwise.
const setDoc = (data: any, agoMs = 20 * MIN) => docs.set(DOC, { data, updateTime: ts(Date.now() - agoMs) });
const doc = () => docs.get(DOC)!.data;
const finish = (status: string, agoMs: number, errorMessage: string | null = null) => pool.query(
  `UPDATE notes SET status = $1, error_message = $2, updated_at = NOW() - ($3::bigint * INTERVAL '1 millisecond') WHERE id = 'n1'`,
  [status, errorMessage, agoMs],
);
async function readyInPostgres() {
  await pool.query(`INSERT INTO summaries (note_id, gist, topics) VALUES ('n1', 'A short sync.', '["Send the deck","Book the room"]'::jsonb)`);
  await pool.query(`INSERT INTO action_items (note_id, text) VALUES ('n1', 'Send the deck'), ('n1', 'Book the room')`);
  await pool.query(`INSERT INTO key_decisions (note_id, text) VALUES ('n1', 'Ship Friday')`);
  await pool.query(`INSERT INTO transcript_lines (note_id, start_ms, end_ms, text) VALUES ('n1', 0, 0, 'Speaker 1: Hello all.'), ('n1', 65000, 65000, 'Speaker 2: Hi.')`);
  await finish('ready', 20 * MIN);
}

beforeEach(async () => {
  await resetDb();
  docs.clear();
  beforeUpdate = null;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
});
afterAll(async () => {
  await pool.end();
  await repo.getPool().end();
});

describe('listRecentlyFinishedNotes', () => {
  it('only notes that finished 10-40 minutes ago', async () => {
    await seedNote('too-new', 'ws', 'u');
    await seedNote('too-old', 'ws', 'u');
    await seedNote('in-flight', 'ws', 'u');
    await finish('ready', 20 * MIN);
    await pool.query(`UPDATE notes SET status = 'error', updated_at = NOW() - INTERVAL '5 minutes' WHERE id = 'too-new'`);
    await pool.query(`UPDATE notes SET status = 'ready', updated_at = NOW() - INTERVAL '60 minutes' WHERE id = 'too-old'`);
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = NOW() - INTERVAL '20 minutes' WHERE id = 'in-flight'`);
    const found = await listRecentlyFinishedNotes({ settledMs: 10 * MIN, windowMs: 30 * MIN, limit: 10 });
    expect(found).toEqual({ notes: [{ noteId: 'n1', workspaceId: 'ws', status: 'ready' }], next: null });
  });
});

// RELEASE.md PR 30a (audit Q20): every note in the window, a page at a time, never capped.
describe('listRecentlyFinishedNotes, paged', () => {
  it('pages through every finished note once, by (updated_at, id), even notes that share a moment', async () => {
    // Seven finished notes in the window: three share one updated_at to the microsecond.
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await seedNote(id, 'ws', 'u');
    await finish('ready', 20 * MIN);
    await pool.query(`UPDATE notes SET status = 'ready', updated_at = '2000-01-01'::timestamptz WHERE id IN ('a', 'b', 'c', 'd', 'e', 'f')`);
    await pool.query(`UPDATE notes SET updated_at = NOW() - INTERVAL '25 minutes' WHERE id IN ('a', 'b', 'c')`);
    await pool.query(`UPDATE notes SET updated_at = NOW() - INTERVAL '15 minutes' - (random() * INTERVAL '1 second') WHERE id IN ('d', 'e')`);
    await pool.query(`UPDATE notes SET status = 'error', updated_at = NOW() - INTERVAL '12 minutes' WHERE id = 'f'`);
    const seen: string[] = [];
    let after: Awaited<ReturnType<typeof listRecentlyFinishedNotes>>['next'] = null;
    let pages = 0;
    do {
      const page = await listRecentlyFinishedNotes({ settledMs: 10 * MIN, windowMs: 30 * MIN, limit: 2, after });
      seen.push(...page.notes.map((n) => n.noteId));
      after = page.next;
      pages += 1;
    } while (after && pages < 10);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'n1']);
    expect(pages).toBe(4); // 2 + 2 + 2 + 1, and the short page says it's the last
  });

  it('reads the finished notes through their own index', async () => {
    const { rows } = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'notes_finished_updated_idx'`);
    expect(rows[0]?.indexdef).toMatch(/\(updated_at, id\) WHERE .*status.*ready.*error.*deleted_at IS NULL/);
  });
});

describe('repairNoteMirror', () => {
  it("a ready note whose doc stayed at 'chunking' (the fast path's mirror failed): status, summary and transcript", async () => {
    await readyInPostgres();
    setDoc({ status: 'chunking', summary: { keyPoints: ['kept'] } });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({
      status: 'ready',
      summary: { gist: 'A short sync.', actionItems: ['Send the deck', 'Book the room'], keyDecisions: ['Ship Friday'], chapters: [], keyPoints: ['kept'] },
      transcript: [{ speaker: 'Speaker 1', text: 'Hello all.', time: '00:00' }, { speaker: 'Speaker 2', text: 'Hi.', time: '01:05' }],
      transcriptTruncated: false,
    });
  });

  it("a failed note whose doc still says in progress: status and Postgres's message", async () => {
    await finish('error', 20 * MIN, 'Transcription failed for this recording.');
    setDoc({ status: 'transcribing' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({ status: 'error', errorMessage: 'Transcription failed for this recording.' });
  });

  // RELEASE.md rev 11, H6: a held note can sit for weeks, so a missed mirror write is repaired.
  it("a note held for minutes whose doc still says in progress: status, with no error message", async () => {
    await finish('awaiting_minutes', 20 * MIN);
    setDoc({ status: 'chunking' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({ status: 'awaiting_minutes', errorMessage: null });
    expect((await listRecentlyFinishedNotes({ settledMs: 10 * MIN, windowMs: 30 * MIN, limit: 10 })).notes)
      .toEqual([{ noteId: 'n1', workspaceId: 'ws', status: 'awaiting_minutes' }]);
  });

  // RELEASE.md PR 30a (audit Q21): a failed note's message is compared too.
  it("a failed note whose doc has another message: Postgres's message; without one, the doc keeps its own", async () => {
    await finish('error', 20 * MIN, 'The recording was too long for your plan.');
    setDoc({ status: 'error', errorMessage: 'Something went wrong.' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({ status: 'error', errorMessage: 'The recording was too long for your plan.' });
    // Now in step: left alone.
    const before = docs.get(DOC)!.updateTime.ms;
    docs.get(DOC)!.updateTime = ts(Date.now() - 20 * MIN);
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('in_step');
    expect(before).toBeGreaterThan(0);
    // An older row with no message never blanks the doc's.
    await finish('error', 20 * MIN, null);
    setDoc({ status: 'error', errorMessage: 'Something went wrong.' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('in_step');
    expect(doc().errorMessage).toBe('Something went wrong.');
  });

  it('a doc already in step is left alone', async () => {
    await readyInPostgres();
    setDoc({ status: 'ready' });
    const before = docs.get(DOC)!.updateTime.ms;
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('in_step');
    expect(docs.get(DOC)!.updateTime.ms).toBe(before);
  });

  it("an earlier run's summary and transcript on the doc (a lost 'ready' mirror after a regenerate or re-queue): replaced from Postgres", async () => {
    await readyInPostgres();
    setDoc({ status: 'summarizing', summary: { gist: 'The old run.', actionItems: ['Old'], keyPoints: ['kept'] }, transcript: [{ speaker: 'A', text: 'old', time: '00:00' }] });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({
      status: 'ready',
      summary: { gist: 'A short sync.', actionItems: ['Send the deck', 'Book the room'], keyDecisions: ['Ship Friday'], keyPoints: ['kept'] },
      transcript: [{ speaker: 'Speaker 1', text: 'Hello all.' }, { speaker: 'Speaker 2', text: 'Hi.' }],
    });
  });

  it('a ready note with no summary row or transcript lines: only the status; the doc keeps what it has', async () => {
    await finish('ready', 20 * MIN);
    setDoc({ status: 'chunking', summary: { gist: 'On the doc.' }, transcript: [{ speaker: 'A', text: 'x', time: '00:00' }] });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(doc()).toMatchObject({ status: 'ready', summary: { gist: 'On the doc.' }, transcript: [{ speaker: 'A', text: 'x', time: '00:00' }] });
  });

  it('the transcript is redacted across lines, as the preview is: a key spanning two chunks', async () => {
    await pool.query(`INSERT INTO summaries (note_id, gist) VALUES ('n1', 'g')`);
    const c = (idx: number) => pool.query(
      `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status) VALUES ('n1', $1, 0, 1, 'p', 'done') RETURNING id`, [idx]);
    const [a, b] = [(await c(0)).rows[0].id, (await c(1)).rows[0].id];
    // Built at runtime, so no key-shaped text sits in the source.
    const dash = '-'.repeat(5);
    const body = ['MIIEvQIBADAN', 'BgkqhkiG9w0B', 'AQEFAASCBKcw'].join('');
    await pool.query(
      `INSERT INTO transcript_lines (note_id, chunk_id, idx, start_ms, end_ms, text) VALUES
         ('n1', $1, 0, 0, 0, $3), ('n1', $2, 0, 1000, 1000, $4), ('n1', $2, 1, 2000, 2000, $5)`,
      [a, b, `${dash}BEGIN PRIVATE KEY${dash}`, body, `${dash}END PRIVATE KEY${dash}`],
    );
    await finish('ready', 20 * MIN);
    setDoc({ status: 'chunking' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('repaired');
    expect(JSON.stringify(doc().transcript)).not.toContain(body);
  });

  it("a doc written in the last 10 minutes (a client's Retry, before Postgres moves): left alone", async () => {
    await finish('error', 20 * MIN, 'old failure');
    setDoc({ status: 'queued', errorMessage: null }, 30_000);
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' }, { settledMs: 10 * MIN })).toBe('doc_recent');
    expect(doc()).toEqual({ status: 'queued', errorMessage: null });
  });

  it('a note deleted between the read and the write: gone, not a failure', async () => {
    await finish('error', 20 * MIN, 'x');
    setDoc({ status: 'transcribing' });
    beforeUpdate = () => { docs.delete(DOC); };
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('gone');
  });

  it('a writer that mirrors between the read and the write wins: the repair backs off', async () => {
    await finish('error', 20 * MIN, 'x');
    setDoc({ status: 'transcribing' });
    beforeUpdate = () => { const d = docs.get(DOC)!; d.data.status = 'queued'; d.updateTime = ts(d.updateTime.ms + 1); };
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('moved');
    expect(doc().status).toBe('queued');
  });

  it('a note re-queued since (Postgres not finished): nothing written', async () => {
    await finish('queued', 20 * MIN);
    setDoc({ status: 'error' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('not_finished');
    expect(doc().status).toBe('error');
  });

  it('no doc, or no note: gone', async () => {
    await finish('ready', 20 * MIN);
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'ws' })).toBe('gone');
    setDoc({ status: 'chunking' });
    expect(await repairNoteMirror(firestore, { noteId: 'n1', workspaceId: 'other-ws' })).toBe('gone');
  });
});

describe('the sweep step', () => {
  it('repairs a finished note in the window, and counts it', async () => {
    await finish('error', 20 * MIN, 'x');
    setDoc({ status: 'transcribing' });
    const noop = () => {};
    const log: any = { info: noop, warn: noop, error: noop, child: () => log };
    const deps = { firestore, auth: { deleteUser: async () => {} }, bucket: { getFiles: async () => [[]] } };
    const counts = await sweep.run({ log, env: {}, traceId: 't', deps, repo, noteTerminal });
    expect(counts.mirror_repair).toBe(1);
    expect(doc().status).toBe('error');
  });

  it('checks every note in the window, past a page of 200 (audit Q20)', async () => {
    // 250 finished notes whose docs are fine, and one behind at the very end of the window.
    await pool.query(
      `INSERT INTO notes (id, workspace_id, author_uid, status, source_type, updated_at)
       SELECT 'bulk-' || g, 'ws', 'u', 'ready', 'recording', NOW() - INTERVAL '30 minutes' + g * INTERVAL '1 millisecond'
         FROM generate_series(1, 250) g`,
    );
    for (let g = 1; g <= 250; g += 1) docs.set(`workspaces/ws/notes/bulk-${g}`, { data: { status: 'ready' }, updateTime: ts(Date.now() - 20 * MIN) });
    await finish('error', 11 * MIN, 'x'); // n1: the newest in the window, so past the first page
    setDoc({ status: 'transcribing' });
    const noop = () => {};
    const warned: string[] = [];
    const log: any = { info: noop, warn: (_o: unknown, m: string) => warned.push(m), error: noop, child: () => log };
    const deps = { firestore, auth: { deleteUser: async () => {} }, bucket: { getFiles: async () => [[]] } };
    const counts = await sweep.run({ log, env: {}, traceId: 't', deps, repo, noteTerminal });
    expect(counts.mirror_repair).toBe(1);
    expect(doc().status).toBe('error');
    expect(warned).not.toContain('mirror_repair_budget_reached');
  });
});
