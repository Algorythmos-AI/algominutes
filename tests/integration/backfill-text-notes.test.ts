import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, count } from './helpers';

// db-job backfill-text-notes (plan rev 12 R12.8 PR 5, S16): the text notes the iPhone wrote straight into Firestore
// before PR 4 get their Postgres rows, through createTextNote, keeping their id, title and time.
const require = createRequire(import.meta.url);
const backfill = require('../../services/db-job/src/handlers/backfill-text-notes.js');

// A Firestore stand-in: workspaces/{ws}/notes/{id}, with the calls the job and createTextNote make.
const docs = new Map<string, Record<string, any>>();
const snap = (path: string) => ({ id: path.split('/').pop()!, ref: { path }, data: () => docs.get(path)! });
function notesQuery(ws: string, type: string, after?: string, max = Infinity): any {
  return {
    limit: (n: number) => notesQuery(ws, type, after, n),
    startAfter: (s: { ref: { path: string } }) => notesQuery(ws, type, s.ref.path, max),
    async get() {
      const prefix = `workspaces/${ws}/notes/`;
      const matching = [...docs.keys()].filter((p) => p.startsWith(prefix) && docs.get(p)!.type === type).sort()
        .filter((p) => after === undefined || p > after).slice(0, max);
      return { docs: matching.map(snap), empty: matching.length === 0, size: matching.length };
    },
  };
}
const firestore: any = {
  collection: (name: string) => {
    if (name !== 'workspaces') throw new Error(`unexpected collection ${name}`);
    return {
      async listDocuments() {
        const ids = new Set([...docs.keys()].map((p) => p.split('/')[1]));
        return [...ids].sort().map((ws) => ({
          id: ws,
          collection: (sub: string) => {
            if (sub !== 'notes') throw new Error(`unexpected subcollection ${sub}`);
            return { where: (_f: string, _op: string, v: string) => notesQuery(ws, v) };
          },
        }));
      },
    };
  },
  doc: (path: string) => ({
    path,
    async create(v: Record<string, unknown>) {
      if (docs.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
      docs.set(path, { ...v });
    },
    async delete() { docs.delete(path); },
  }),
};

// A doc as the iPhone wrote it (ScanSheet before R12.8 PR 4).
const iphoneDoc = (over: Record<string, unknown> = {}) => ({
  title: 'Receipt from the cafe', status: 'ready', type: 'scan_text', duration: 0,
  rawText: 'Receipt from the cafe\n\nCoffee 4.50', wordCount: 6, transcriptTruncated: false,
  transcript: [
    { speaker: 'Scanned image', text: 'Receipt from the cafe', time: '' },
    { speaker: 'Scanned image', text: 'Coffee 4.50', time: '' },
  ],
  summary: { gist: 'Scanned image - 6 words extracted.', actionItems: [], keyDecisions: [] },
  workspaceId: 'workspace_alice', authorId: 'alice', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z',
  ...over,
});

let logs: { fields: any; event: string }[] = [];
const log = {
  info: (fields: any, event: string) => logs.push({ fields, event }),
  warn: (fields: any, event: string) => logs.push({ fields, event }),
  error: (fields: any, event: string) => logs.push({ fields, event }),
  child: () => log,
};
const job = (mode?: string, extra: Record<string, string> = {}) =>
  backfill.run({ log, traceId: 'trace-backfill', env: { ...(mode ? { MODE: mode } : {}), ...extra }, firestore, repo });

beforeEach(async () => {
  await resetDb();
  docs.clear();
  logs = [];
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
  docs.set('workspaces/workspace_alice/notes/scan-1', iphoneDoc());
  docs.set('workspaces/workspace_alice/notes/rec-1', { ...iphoneDoc(), type: 'recording' });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('db-job backfill-text-notes', () => {
  it('dry-run (the default) counts what it would create, and writes nothing', async () => {
    const r = await job();
    expect(r).toMatchObject({ mode: 'dry-run', seen: 1, wouldCreate: 1, created: 0, already: 0 });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'backfill_text_notes_done' }));
  });

  it("run creates the note in Postgres from the doc, keeping its id, its title and its time, and leaves the doc", async () => {
    const before = docs.get('workspaces/workspace_alice/notes/scan-1');
    const r = await job('run');
    expect(r).toMatchObject({ mode: 'run', seen: 1, created: 1 });
    const { rows: [n] } = await pool.query(`SELECT workspace_id, author_uid, title, status, source_type, created_at FROM notes WHERE id = 'scan-1'`);
    expect(n).toMatchObject({ workspace_id: 'workspace_alice', author_uid: 'alice', title: 'Receipt from the cafe', status: 'ready', source_type: 'scan_text' });
    expect(new Date(n.created_at).toISOString()).toBe('2026-09-01T08:00:00.000Z');
    const { rows: lines } = await pool.query(`SELECT text, speaker_name FROM transcript_lines WHERE note_id = 'scan-1' ORDER BY idx`);
    expect(lines).toEqual([{ text: 'Receipt from the cafe', speaker_name: 'Scanned image' }, { text: 'Coffee 4.50', speaker_name: 'Scanned image' }]);
    expect(docs.get('workspaces/workspace_alice/notes/scan-1')).toEqual(before);
    // Claimed for embedding with the note: the sweep's lost-embed redrive indexes it.
    expect((await pool.query(`SELECT embedder_enqueued_at FROM notes WHERE id = 'scan-1'`)).rows[0].embedder_enqueued_at).not.toBeNull();
    // Recordings are not its business.
    expect(await count(`SELECT 1 FROM notes WHERE id = 'rec-1'`)).toBe(0);
  });

  it('is idempotent: a second run finds the note in Postgres and creates nothing', async () => {
    await job('run');
    const r = await job('run');
    expect(r).toMatchObject({ seen: 1, already: 1, created: 0 });
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'scan-1'`)).toBe(2);
  });

  it('a doc with only its transcript is rebuilt from the transcript', async () => {
    docs.set('workspaces/workspace_alice/notes/scan-1', iphoneDoc({ rawText: undefined }));
    await job('run');
    const { rows } = await pool.query(`SELECT text FROM transcript_lines WHERE note_id = 'scan-1' ORDER BY idx`);
    expect(rows.map((r) => r.text)).toEqual(['Receipt from the cafe', 'Coffee 4.50']);
  });

  it("names the lines from the doc's own source (a PDF stays a PDF)", async () => {
    docs.set('workspaces/workspace_alice/notes/scan-1', iphoneDoc({
      transcript: [{ speaker: 'PDF document', text: 'Quarterly report', time: '' }], rawText: 'Quarterly report',
    }));
    await job('run');
    expect((await pool.query(`SELECT speaker_name FROM transcript_lines WHERE note_id = 'scan-1'`)).rows[0].speaker_name).toBe('PDF document');
  });

  it("skips a deleted account's leftover note, and another account's doc in a workspace it isn't in, and carries on", async () => {
    await seedUser('bob');
    await pool.query(`INSERT INTO account_deletions (uid) VALUES ('bob')`);
    docs.set('workspaces/workspace_bob/notes/scan-b', iphoneDoc({ workspaceId: 'workspace_bob', authorId: 'bob' }));
    docs.set('workspaces/workspace_alice/notes/scan-x', iphoneDoc({ authorId: 'mallory' }));
    const r = await job('run');
    expect(r).toMatchObject({ seen: 3, created: 1, accountDeleted: 1, refused: 1, failed: 0 });
    expect(await count(`SELECT 1 FROM notes WHERE id IN ('scan-b', 'scan-x')`)).toBe(0);
  });

  it('pages through a workspace, and stops at its limit', async () => {
    for (let i = 0; i < 7; i++) docs.set(`workspaces/workspace_alice/notes/scan-p${i}`, iphoneDoc());
    expect(await job('dry-run', { BACKFILL_PAGE: '3' })).toMatchObject({ seen: 8, wouldCreate: 8 });
    expect(await job('run', { BACKFILL_PAGE: '3', BACKFILL_LIMIT: '5' })).toMatchObject({ seen: 5, created: 5, limitReached: true });
    expect(await count(`SELECT 1 FROM notes`)).toBe(5);
    expect(await job('run', { BACKFILL_PAGE: '3' })).toMatchObject({ seen: 8, created: 3, already: 5 });
  });

  it('refuses a mode it does not know', async () => {
    await expect(job('delete-everything')).rejects.toThrow(/MODE/);
  });

  // Logs carry ids and counts, never a note's text.
  it('never logs the text', async () => {
    await job('run');
    expect(JSON.stringify(logs)).not.toContain('Coffee 4.50');
  });
});
