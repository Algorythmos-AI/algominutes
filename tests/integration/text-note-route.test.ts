import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// POST /v1/notes/text (plan rev 12 R12.8 PR 3, S16), driven for real against Postgres, with Firestore faked at the
// firebase-admin boundary and the embed enqueue injected.
const docs = new Map<string, Record<string, unknown>>();
vi.mock('firebase-admin/firestore', async (orig) => ({
  ...(await orig<typeof import('firebase-admin/firestore')>()),
  getFirestore: () => ({
    doc: (path: string) => ({
      async create(v: Record<string, unknown>) {
        if (docs.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
        docs.set(path, v);
      },
      async delete() { docs.delete(path); },
    }),
  }),
}));
// @ts-expect-error: plain ESM route module, no type declarations
const { createTextNoteRoute } = await import('../../services/api/src/routes/text-notes.js');

const env = {
  TASKS_PROJECT: 'proj', TASKS_LOCATION: 'australia-southeast1', EMBED_QUEUE: 'embed',
  EMBEDDER_URL: 'https://embedder.example', JOBS_SA_EMAIL: 'run-jobs@proj.iam.gserviceaccount.com',
};
let enqueued: any[] = [];
let enqueueFails = false;
const enqueueTask = async (t: any) => {
  if (enqueueFails) throw new Error('14 UNAVAILABLE');
  enqueued.push(t);
};
let logs: { level: string; fields: any; event: string }[] = [];

beforeEach(async () => {
  await resetDb();
  docs.clear();
  enqueued = [];
  enqueueFails = false;
  logs = [];
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('workspace_alice', 'alice');
  await seedWorkspace('workspace_bob', 'bob');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function call(uid: string, body: unknown, routeEnv: Record<string, string> = env) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
  const mk = (bound: any) => {
    const at = (level: string) => (fields: any, event: string) => logs.push({ level, fields: { ...bound, ...fields }, event });
    return { info: at('info'), warn: at('warn'), error: at('error'), child: (f: any) => mk({ ...bound, ...f }) };
  };
  const route = createTextNoteRoute({ env: routeEnv, enqueueTask });
  await route({ uid, traceId: 'trace-text-1', body, log: mk({ traceId: 'trace-text-1' }) }, res);
  return out;
}

const body = (over: Record<string, unknown> = {}) => ({
  noteId: 'scan-1', workspaceId: 'workspace_alice', source: 'scanned_image',
  text: 'Receipt from the cafe\n\nCoffee 4.50', ...over,
});

describe('POST /v1/notes/text', () => {
  it('writes the note to Postgres and its doc, answers ready, and enqueues its embedding', async () => {
    expect(await call('alice', body())).toEqual({ status: 200, body: { noteId: 'scan-1', status: 'ready' } });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'scan-1' AND source_type = 'scan_text' AND status = 'ready'`)).toBe(1);
    expect(docs.get('workspaces/workspace_alice/notes/scan-1')).toMatchObject({ status: 'ready', type: 'scan_text' });
    expect(enqueued).toEqual([expect.objectContaining({
      projectId: 'proj', location: 'australia-southeast1', queue: 'embed', targetUrl: 'https://embedder.example',
      oidcServiceAccount: 'run-jobs@proj.iam.gserviceaccount.com', traceId: 'trace-text-1',
      payload: { noteId: 'scan-1', workspaceId: 'workspace_alice', uid: 'alice' },
    })]);
  });

  it('a retry answers ready again and enqueues nothing more (the first embed, or the sweep, covers it)', async () => {
    await call('alice', body());
    expect(await call('alice', body())).toEqual({ status: 200, body: { noteId: 'scan-1', status: 'ready' } });
    expect(enqueued).toHaveLength(1);
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'scan-1'`)).toBe(2);
  });

  it('a failed enqueue still answers ready: the note is saved, and the sweep re-drives the embed', async () => {
    enqueueFails = true;
    expect(await call('alice', body())).toEqual({ status: 200, body: { noteId: 'scan-1', status: 'ready' } });
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', event: 'text_note_embed_enqueue_failed' }));
    expect((await pool.query(`SELECT embedder_enqueued_at FROM notes WHERE id = 'scan-1'`)).rows[0].embedder_enqueued_at).not.toBeNull();
  });

  it('an embedder that is not configured is logged, and the note is still saved', async () => {
    const { EMBEDDER_URL: _unset, ...partial } = env;
    expect((await call('alice', body(), partial)).status).toBe(200);
    expect(enqueued).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', event: 'text_note_embed_unconfigured' }));
  });

  it('refuses a text past the contract cap with 413, before writing anything', async () => {
    const r = await call('alice', body({ text: 'x'.repeat(300_001) }));
    expect(r.status).toBe(413);
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  it('refuses a body the contract does not accept with 400', async () => {
    expect((await call('alice', body({ source: 'audio' }))).status).toBe(400);
    expect((await call('alice', body({ noteId: 'bad id/../x' }))).status).toBe(400);
    expect((await call('alice', { workspaceId: 'workspace_alice' })).status).toBe(400);
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  // Two accounts (CLAUDE.md §1): B can't write into A's workspace, or take A's note id.
  it("refuses another account's workspace with 403, and another's note id with 409", async () => {
    expect((await call('bob', body())).status).toBe(403);
    await call('alice', body());
    expect((await call('bob', body({ workspaceId: 'workspace_bob' })))).toMatchObject({ status: 409 });
    expect(await count(`SELECT 1 FROM notes WHERE workspace_id = 'workspace_bob'`)).toBe(0);
  });

  it("refuses a recording's id with 409, never overwriting it", async () => {
    await seedNote('rec-1', 'workspace_alice', 'alice');
    expect(await call('alice', body({ noteId: 'rec-1' }))).toMatchObject({ status: 409 });
    expect((await pool.query(`SELECT source_type FROM notes WHERE id = 'rec-1'`)).rows[0].source_type).not.toBe('scan_text');
  });

  it('refuses a deleted note id with 404, as an upload does', async () => {
    await call('alice', body());
    const { deleteNote } = await import('@algominutes/db');
    const noop = () => {};
    const quiet = { info: noop, warn: noop, error: noop };
    const { getFirestore } = await import('firebase-admin/firestore');
    await deleteNote(getFirestore() as any, { noteId: 'scan-1', workspaceId: 'workspace_alice', uid: 'alice', traceId: 'tr' }, quiet);
    expect(await call('alice', body())).toMatchObject({ status: 404 });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'scan-1'`)).toBe(0);
  });

  it('refuses a deleted account with 401', async () => {
    await pool.query(`INSERT INTO account_deletions (uid) VALUES ('alice') ON CONFLICT DO NOTHING`);
    expect(await call('alice', body())).toMatchObject({ status: 401, body: { error: 'account_deleted' } });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  // The log auditor's fields, and never the text itself.
  it('logs text_note_created with its correlation fields, and never the text', async () => {
    await call('alice', body());
    const created = logs.find((l) => l.event === 'text_note_created')!;
    expect(created.fields).toMatchObject({ noteId: 'scan-1', workspaceId: 'workspace_alice', userId: 'alice', traceId: 'trace-text-1' });
    expect(JSON.stringify(logs)).not.toContain('Coffee 4.50');
  });
});
