import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool, markQueued, deleteAccountData } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// POST /v1/process end to end against real Postgres. Only the network edges are
// faked: Firestore (the mirror), GCS (the size probe), Cloud Tasks (the
// enqueue) and the Firestore rate-limit counter. Metering, the trial, the queue
// state and the tenant boundary all run for real.
const docs = new Map<string, Record<string, unknown>>();
function docRef(path: string) {
  return {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
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
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({ bucket: () => ({ file: () => ({ getMetadata: async () => [{ size: '1000' }] }) }) }),
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
const { processIntelligenceRoute } = await import('../../services/api/src/routes/process-intelligence.js');

process.env.TRANSCODER_URL = 'https://transcoder.invalid';
process.env.JOBS_SA_EMAIL = 'jobs@example.invalid';
process.env.TASKS_PROJECT = 'test-project';

beforeEach(async () => {
  await resetDb();
  docs.clear();
  enqueued.length = 0;
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

async function kickoff(uid: string, body: Record<string, unknown>) {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.status ||= 200; out.body = b; return this; },
  };
  const noop = () => {};
  const log = { info: noop, warn: noop, error: (o: any, m?: string) => { if (process.env.DEBUG_KICKOFF) console.error(m, o?.err?.message ?? o); }, child: () => log };
  await processIntelligenceRoute({ uid, authEmail: `${uid}@test.invalid`, log, traceId: 'trace-1', headers: {}, body }, res);
  return out;
}

const upload = (uid: string, noteId: string) => ({
  noteId, workspaceId: `workspace_${uid}`, type: 'recording',
  storagePath: `recordings/workspace_${uid}/${noteId}.m4a`, durationSec: 150,
});
const youtube = (uid: string, noteId: string) => ({
  noteId, workspaceId: `workspace_${uid}`, type: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abc', durationSec: 60,
});
const noteDoc = (uid: string, noteId: string) => {
  docs.set(`workspaces/workspace_${uid}/notes/${noteId}`, { authorId: uid, status: 'uploading' });
};

describe('POST /v1/process, first kickoff of a new note', () => {
  it('queues an uploaded recording, and debits its minutes against the new note', async () => {
    // POST /v1/uploads created the user and the workspace; nothing creates the note row before the kickoff.
    await seedUser('alice');
    await seedWorkspace('workspace_alice', 'alice');
    noteDoc('alice', 'n1');
    const out = await kickoff('alice', upload('alice', 'n1'));
    expect(out).toMatchObject({ status: 200, body: { success: true, noteId: 'n1', status: 'queued' } });
    expect(await count(`SELECT 1 FROM notes WHERE id = 'n1' AND status = 'queued'`)).toBe(1);
    const debits = await pool.query(`SELECT uid, workspace_id, note_id, minutes::int AS minutes FROM usage_ledger WHERE entry_type = 'debit'`);
    expect(debits.rows).toEqual([{ uid: 'alice', workspace_id: 'workspace_alice', note_id: 'n1', minutes: 3 }]);
    expect(enqueued).toHaveLength(1);
    expect(docs.get('workspaces/workspace_alice/notes/n1')).toMatchObject({ status: 'queued' });
  });

  it("queues a brand-new user's first YouTube import (no user row yet): trial, note and debit", async () => {
    noteDoc('bob', 'y1');
    const out = await kickoff('bob', youtube('bob', 'y1'));
    expect(out).toMatchObject({ status: 200, body: { status: 'queued' } });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'bob'`)).toBe(1);
    expect(await count(`SELECT 1 FROM subscriptions WHERE uid = 'bob'`)).toBe(1);
    expect(await count(`SELECT 1 FROM usage_ledger WHERE note_id = 'y1' AND entry_type = 'debit'`)).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it('a duplicate kickoff of the in-flight note neither re-queues nor debits again', async () => {
    await seedUser('alice');
    await seedWorkspace('workspace_alice', 'alice');
    noteDoc('alice', 'n1');
    expect((await kickoff('alice', upload('alice', 'n1'))).status).toBe(200);
    const again = await kickoff('alice', upload('alice', 'n1'));
    expect(again).toMatchObject({ status: 202, body: { inFlight: true, status: 'queued' } });
    expect(await count(`SELECT 1 FROM usage_ledger WHERE note_id = 'n1'`)).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it('markQueued debits only when it queues: the in-transaction duplicate path charges nothing', async () => {
    await seedUser('alice');
    const input = {
      noteId: 'n2', workspaceId: 'workspace_alice', authorUid: 'alice', sourceType: 'recording',
      storagePath: 'recordings/workspace_alice/n2.m4a', meter: { minutes: 4, idempotencyKey: 'n2:ingest' },
    };
    // Past the route's read-only pre-check, both reach the transaction; the second waits on the note lock.
    const [a, b] = await Promise.all([markQueued(fakeDb as any, input, quietLog), markQueued(fakeDb as any, input, quietLog)]);
    expect([a.queued, b.queued].sort()).toEqual([false, true]);
    const debits = await pool.query(`SELECT minutes::int AS minutes FROM usage_ledger WHERE note_id = 'n2'`);
    expect(debits.rows).toEqual([{ minutes: 4 }]);
  });

  it('a deleted account (its token still valid) gets 401 at the trial step, and nothing is re-created', async () => {
    await seedUser('gone');
    await deleteAccountData({ uid: 'gone' }, quietLog);
    noteDoc('gone', 'y9');
    expect(await kickoff('gone', youtube('gone', 'y9'))).toEqual({ status: 401, body: { error: 'account_deleted' } });
    expect(await count(`SELECT 1 FROM users WHERE uid = 'gone'`)).toBe(0);
    expect(await count(`SELECT 1 FROM usage_ledger`)).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("a note id that lives in another workspace is refused, and nothing is debited or queued", async () => {
    await seedUser('alice');
    await seedUser('eve');
    await seedWorkspace('workspace_alice', 'alice');
    await seedNote('shared-id', 'workspace_alice', 'alice');
    noteDoc('eve', 'shared-id');
    const out = await kickoff('eve', upload('eve', 'shared-id'));
    expect(out).toMatchObject({ status: 404 });
    expect(await count(`SELECT 1 FROM usage_ledger`)).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});
