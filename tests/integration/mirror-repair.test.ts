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
    expect(found).toEqual([{ noteId: 'n1', workspaceId: 'ws', status: 'ready' }]);
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
});
