import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as repo from '@algominutes/db';
import { CreateNoteResponse } from '@algominutes/contracts/schemas';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// POST /v1/notes (docs/plans/RELEASE.md PR 35) against real Postgres: the browser extension, which never
// writes Firestore, has its note created from the upload its recording went to, then kicks it off as the
// web does.
const { getPool, createUploadSession, deleteAccountData } = repo;

// Firestore and Cloud Storage, faked. A doc hook lets a test act between the checks and the write.
const docs = new Map<string, Record<string, unknown>>();
let onCreate: ((path: string) => Promise<void>) | null = null;
let writes = 0; // docs ever written, even if deleted since
let failCreate = false;
function docRef(path: string) {
  return {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async create(v: Record<string, unknown>) {
      if (onCreate) await onCreate(path);
      if (failCreate) throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 });
      if (docs.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
      writes += 1;
      docs.set(path, v);
    },
    async set(v: Record<string, unknown>, o?: { merge?: boolean }) {
      docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...v } : v);
    },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() { docs.delete(path); },
  };
}
const fakeDb = { doc: docRef, collection: () => ({ add: async () => ({}) }) };
vi.mock('firebase-admin/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFirestore: () => fakeDb,
}));
const objects = new Set<string>();
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      file: (p: string) => ({
        exists: async () => [objects.has(p)],
        getMetadata: async () => [{ size: '1000' }],
      }),
    }),
  }),
}));
const enqueued: Array<Record<string, unknown>> = [];
vi.mock('@algominutes/ai/cloud-tasks.cjs', () => ({
  default: { enqueueTask: async ({ payload }: { payload: Record<string, unknown> }) => { enqueued.push(payload); } },
}));
vi.mock('@algominutes/ai/intelligence.cjs', async (importOriginal) => {
  const real = ((await importOriginal()) as { default: Record<string, unknown> }).default;
  return { default: { ...real, enforceUsageBudget: async () => {} } };
});
// @ts-expect-error: plain ESM route module, no type declarations
const { createNoteRoute } = await import('../../services/api/src/routes/create-note.js');
// @ts-expect-error: plain ESM route module, no type declarations
const { processIntelligenceRoute } = await import('../../services/api/src/routes/process-intelligence.js');

process.env.TRANSCODER_URL = 'https://transcoder.invalid';
process.env.JOBS_SA_EMAIL = 'jobs@example.invalid';
process.env.TASKS_PROJECT = 'test-project';

const WS = 'workspace_alice';
const PATH = `recordings/${WS}/n1.webm`;
const DOC = `workspaces/${WS}/notes/n1`;

beforeEach(async () => {
  await resetDb();
  docs.clear();
  objects.clear();
  enqueued.length = 0;
  onCreate = null;
  writes = 0;
  failCreate = false;
  await seedUser('alice');
  await seedWorkspace(WS, 'alice');
  await seedUser('bob');
  await seedWorkspace('workspace_bob', 'bob');
});
afterAll(async () => { await getPool().end(); await pool.end(); });

function captureLog() {
  const lines: Array<[string, string, Record<string, unknown>]> = [];
  const make = (bound: Record<string, unknown>): any => {
    const at = (level: string) => (o: Record<string, unknown>, m: string) => { lines.push([level, m, { ...bound, ...o }]); };
    return { info: at('info'), warn: at('warn'), error: at('error'), child: (b: Record<string, unknown>) => make({ ...bound, ...b }) };
  };
  return { log: make({}), lines };
}
async function call(route: (req: any, res: any) => Promise<unknown>, req: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.status ||= 200; out.body = b; return this; },
  };
  const { log, lines } = captureLog();
  await route({ uid: 'alice', authEmail: 'alice@test.invalid', headers: {}, traceId: 'trace-35', log, ...req }, res);
  return { ...out, lines };
}
async function upload(uid = 'alice', noteId = 'n1', expiresAt = new Date(Date.now() + 3_600_000)) {
  const ws = `workspace_${uid}`;
  const storagePath = `recordings/${ws}/${noteId}.webm`;
  const id = await createUploadSession({
    uid, workspaceId: ws, noteId, storagePath, sessionUri: `https://storage.invalid/${noteId}`,
    totalBytes: 1000, expiresAt,
  }, quietLog);
  return { id, storagePath };
}
const create = (uploadId: string, extra: Record<string, unknown> = {}, uid = 'alice') =>
  call(createNoteRoute, { uid, body: { uploadId, title: 'Team sync', type: 'recording', mimeType: 'audio/webm', durationSec: 1800, ...extra } });

describe('POST /v1/notes', () => {
  it('makes the note the web would, from the finished upload, and it kicks off like one', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    const out = await create(up.id);
    expect(out.status).toBe(200);
    expect(CreateNoteResponse.parse(out.body)).toEqual({ noteId: 'n1', workspaceId: WS, storagePath: PATH, created: true });
    expect(docs.get(DOC)).toEqual({
      title: 'Team sync', status: 'processing', type: 'recording', mimeType: 'audio/webm', storagePath: PATH,
      duration: 1800, workspaceId: WS, authorId: 'alice', createdAt: expect.any(String), updatedAt: expect.any(String),
    });
    expect(out.lines).toContainEqual(['info', 'note_created_for_client', { noteId: 'n1', workspaceId: WS, uploadId: up.id, created: true, type: 'recording' }]);

    const kicked = await call(processIntelligenceRoute, {
      body: { noteId: 'n1', workspaceId: WS, type: 'recording', storagePath: PATH },
    });
    expect(kicked).toMatchObject({ status: 200, body: { status: 'queued' } });
    expect(enqueued).toHaveLength(1);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1' AND workspace_id = $1 AND status = 'queued'`, [WS])).toBe(1);
  });

  it('asked again, answers the same note and writes nothing new', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await create(up.id);
    const first = docs.get(DOC);
    const again = await create(up.id, { title: 'Another title' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ noteId: 'n1', workspaceId: WS, storagePath: PATH, created: false });
    expect(docs.get(DOC)).toBe(first);
  });

  it('only for the caller\'s own upload: bob can\'t make a note of alice\'s', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    const out = await create(up.id, {}, 'bob');
    expect(out.status).toBe(404);
    expect(docs.size).toBe(0);
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  it('refuses an expired upload, an unknown one and a malformed request', async () => {
    const old = await upload('alice', 'n2', new Date(Date.now() - 1000));
    objects.add(old.storagePath);
    expect((await create(old.id)).status).toBe(404);
    expect((await create('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await create('not-a-uuid')).status).toBe(400);
    const up = await upload();
    objects.add(up.storagePath);
    expect((await create(up.id, { title: '  ' })).status).toBe(400);
    expect((await create(up.id, { type: 'youtube' })).status).toBe(400);
    expect((await create(up.id, { mimeType: 'text/html' })).status).toBe(400);
    expect(docs.size).toBe(0);
  });

  it('waits for the upload to finish: no audio, no note', async () => {
    const up = await upload();
    const out = await create(up.id);
    expect(out.status).toBe(409);
    expect(docs.size).toBe(0);
  });

  it('never gives a deleted note a doc', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await pool.query(`INSERT INTO deleted_notes (note_id, workspace_id) VALUES ('n1', $1)`, [WS]);
    const out = await create(up.id);
    expect(out.status).toBe(410);
    // Not even for a moment: a client listening would see the deleted note come back.
    expect(writes).toBe(0);
  });

  it('a deletion that lands between the check and the write leaves no doc', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    onCreate = async () => {
      onCreate = null;
      await pool.query(`INSERT INTO deleted_notes (note_id, workspace_id) VALUES ('n1', $1)`, [WS]);
    };
    const out = await create(up.id);
    expect(out.status).toBe(410);
    expect(docs.has(DOC)).toBe(false);
  });

  it('leaves a note Postgres already has as it is', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await seedNote('n1', WS, 'alice');
    const out = await create(up.id);
    expect(out).toMatchObject({ status: 200, body: { created: false } });
    expect(docs.size).toBe(0);
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1' AND status = 'queued'`)).toBe(1);
  });

  it('a note id in someone else\'s workspace is refused', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await seedNote('n1', 'workspace_bob', 'bob');
    const out = await create(up.id);
    expect(out.status).toBe(403);
    expect(docs.size).toBe(0);
  });

  it('never takes over a doc that is someone else\'s', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    docs.set(DOC, { authorId: 'bob', status: 'processing' });
    const out = await create(up.id);
    expect(out.status).toBe(403);
    expect(docs.get(DOC)).toEqual({ authorId: 'bob', status: 'processing' });
  });

  it('a deleted account gets no note', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await pool.query('INSERT INTO account_deletions (uid) VALUES ($1)', ['alice']);
    const out = await create(up.id);
    expect(out.status).toBe(401);
    expect(docs.size).toBe(0);
  });

  it('an account deleted while the request runs leaves no doc behind', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    onCreate = async () => {
      onCreate = null;
      // Account deletion leaves no note tombstone for a note Postgres never had.
      await deleteAccountData({ uid: 'alice' }, quietLog);
    };
    const out = await create(up.id);
    expect(out.status).toBe(401);
    expect(docs.has(DOC)).toBe(false);
    expect(await count(`SELECT 1 FROM deleted_notes`)).toBe(0);
  });

  it('a deleted account, or a user no longer in the workspace, never gets a doc, even past the route\'s own check', async () => {
    await pool.query('INSERT INTO account_deletions (uid) VALUES ($1)', ['alice']);
    const input = { noteId: 'n1', workspaceId: WS, uid: 'alice', title: 't', type: 'recording' as const, mimeType: 'audio/webm', storagePath: PATH };
    expect(await repo.createClientNoteDoc(fakeDb as any, input, quietLog)).toEqual({ created: false, deleted: 'account' });
    await pool.query('DELETE FROM account_deletions');
    // Someone else still in the workspace doesn't let alice in.
    await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, 'bob', 'member')`, [WS]);
    await pool.query('DELETE FROM workspace_members WHERE uid = $1', ['alice']);
    expect(await repo.createClientNoteDoc(fakeDb as any, input, quietLog)).toEqual({ created: false, deleted: 'account' });
    expect(writes).toBe(0);
  });

  it('after the account is deleted, its upload is gone too', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await deleteAccountData({ uid: 'alice' }, quietLog);
    expect((await create(up.id)).status).toBe(404);
    expect(docs.size).toBe(0);
  });

  it('an unexpected failure is logged with the note it was for', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    failCreate = true;
    const { log, lines } = captureLog();
    const req: any = { uid: 'alice', headers: {}, log, body: { uploadId: up.id, title: 'Team sync', type: 'recording', mimeType: 'audio/webm' } };
    const res = { status() { return this; }, json() { return this; } };
    await expect(createNoteRoute(req, res)).rejects.toThrow('UNAVAILABLE');
    // What app.js's error handler does with an unhandled rejection.
    req.log.error({ err: 'UNAVAILABLE' }, 'unhandled_error');
    expect(lines.at(-1)).toEqual(['error', 'unhandled_error', { noteId: 'n1', workspaceId: WS, uploadId: up.id, err: 'UNAVAILABLE' }]);
  });

  it('no duration, no duration field', async () => {
    const up = await upload();
    objects.add(up.storagePath);
    await create(up.id, { durationSec: undefined });
    expect(docs.get(DOC)).not.toHaveProperty('duration');
  });
});
