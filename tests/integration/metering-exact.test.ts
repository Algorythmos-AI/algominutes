import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool, grantEntitlement, queueNoteRun, noteChargeStands, ensureTrial, listStuckNotes } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// POST /v1/process refuses correctly (docs/plans/RELEASE.md PR 3): the quota is
// checked in the transaction that debits, a retry whose charge stands needs no
// headroom, one note holds at most the plan's longest recording, and a kickoff
// at the daily spend cap is refused before anything is queued or charged. Plus
// the refunds on the two failure paths that had no Postgres test.
const docs = new Map<string, Record<string, unknown>>();
let failNextQueuedMirror = false;
function docRef(path: string) {
  return {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async set(v: Record<string, unknown>, o?: { merge?: boolean }) {
      docs.set(path, o?.merge ? { ...(docs.get(path) ?? {}), ...v } : v);
    },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      if (failNextQueuedMirror && v.status === 'queued') {
        failNextQueuedMirror = false;
        throw Object.assign(new Error('14 UNAVAILABLE: firestore'), { code: 14 });
      }
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
// The daily cap's reader is the transcoder's usage_events sum; here a switch.
let capped = false;
const spendChecks: string[] = [];
vi.mock('@algominutes/ai/spend-guard.cjs', async (importOriginal) => {
  const real = ((await importOriginal()) as { default: Record<string, unknown> }).default;
  return {
    default: {
      ...real,
      assertUnderDailyCap: async () => {
        spendChecks.push('checked');
        if (capped) throw Object.assign(new Error('daily_spend_cap_exceeded'), { code: 'SPEND_CAP_EXCEEDED' });
        return { ok: true };
      },
    },
  };
});
// @ts-expect-error: plain ESM route module, no type declarations
const { processIntelligenceRoute } = await import('../../services/api/src/routes/process-intelligence.js');
const { SPEND_CAP_MESSAGE } = (await import('@algominutes/ai/spend-guard.cjs')).default as { SPEND_CAP_MESSAGE: string };

const ENV = { TRANSCODER_URL: 'https://transcoder.invalid', JOBS_SA_EMAIL: 'jobs@example.invalid', TASKS_PROJECT: 'test-project' };
Object.assign(process.env, ENV);

beforeEach(async () => {
  await resetDb();
  docs.clear();
  enqueued.length = 0;
  spendChecks.length = 0;
  capped = false;
  failNextQueuedMirror = false;
  Object.assign(process.env, ENV);
  await seedUser('alice');
  await seedWorkspace('workspace_alice', 'alice');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

// A retry reuses the note's doc as it is; only a new note starts one.
const noteDoc = (noteId: string) => {
  const path = `workspaces/workspace_alice/notes/${noteId}`;
  if (!docs.has(path)) docs.set(path, { authorId: 'alice', status: 'uploading' });
};
async function kickoff(noteId: string, durationSec: number) {
  noteDoc(noteId);
  const out = { status: 0, body: undefined as any };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.status ||= 200; out.body = b; return this; },
  };
  const log: any = { info() {}, warn() {}, error() {}, child: () => log };
  await processIntelligenceRoute({
    uid: 'alice', authEmail: 'alice@test.invalid', log, traceId: 'trace-meter', headers: {},
    body: { noteId, workspaceId: 'workspace_alice', type: 'recording', storagePath: `recordings/workspace_alice/${noteId}.m4a`, durationSec },
  }, res);
  return out;
}
const ledger = async () => (await pool.query(
  `SELECT note_id, entry_type, minutes::float8 AS m, reason FROM usage_ledger ORDER BY id`,
)).rows.map((r: any) => `${r.note_id} ${r.entry_type} ${r.m} ${r.reason}`);
const statusOf = async (noteId: string) => (await pool.query(`SELECT status, error_message FROM notes WHERE id = $1`, [noteId])).rows[0];

describe('the quota is checked where the minutes are debited', () => {
  it('two kickoffs racing for the last minutes: one queues, the other is held for minutes, and nothing is overspent', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 150 });
    // Hold the user's meter lock, so both kickoffs pass the early check and meet in markQueued.
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['meter:alice']);
    const racing = Promise.all([kickoff('n1', 100 * 60), kickoff('n2', 100 * 60)]);
    await new Promise((r) => setTimeout(r, 300));
    await blocker.query('COMMIT');
    blocker.release();
    const outs = await racing;
    expect(outs.map((o) => o.status).sort()).toEqual([200, 202]);
    // An uploaded recording over the minutes left is held, not refused (RELEASE.md rev 11, H6c).
    expect(outs.find((o) => o.status === 202)!.body).toMatchObject({ held: true, status: null });
    expect(await ledger()).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    // The held note is kept, uncharged.
    expect(await count(`SELECT 1 FROM notes WHERE status = 'awaiting_minutes'`)).toBe(1);
    expect(await count(`SELECT 1 FROM notes WHERE status = 'queued'`)).toBe(1);
  });

  it("a retry whose earlier charge still stands needs no headroom, and isn't charged again", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 3 });
    expect((await kickoff('n1', 150)).status).toBe(200);
    // It failed without a refund (a charge that stands), and the user is now at their limit.
    await pool.query(`UPDATE notes SET status = 'error' WHERE id = 'n1'`);
    expect(await ledger()).toEqual(['n1 debit 3 ingest']);
    const retry = await kickoff('n1', 150);
    expect(retry).toMatchObject({ status: 200, body: { status: 'queued' } });
    expect(await ledger()).toEqual(['n1 debit 3 ingest']);
    // A different note still has no headroom: held for minutes, uncharged.
    expect(await kickoff('n2', 60)).toMatchObject({ status: 202, body: { held: true } });
    expect(await ledger()).toEqual(['n1 debit 3 ingest']);
  });
});

// RELEASE.md rev 11, L7 (H2c).
describe('the kickoff guards what it lets through to paid work', () => {
  it('with no minutes left, a recording that claims no length is held too: it will be charged at least a minute', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 3 });
    expect((await kickoff('n1', 180)).status).toBe(200); // uses all 3
    const out = await kickoff('n2', 0);
    // Held at the kickoff (RELEASE.md rev 11, H6c), not queued to be downloaded and measured first.
    expect(out).toMatchObject({ status: 202, body: { held: true } });
    expect(await statusOf('n2')).toMatchObject({ status: 'awaiting_minutes' });
    expect(enqueued).toHaveLength(1);
    expect(await ledger()).toEqual(['n1 debit 3 ingest']);
  });

  it("five notes in flight at once is the most: the sixth waits, and another user's don't count", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    for (let i = 1; i <= 5; i++) expect((await kickoff(`n${i}`, 60)).status).toBe(200);
    const sixth = await kickoff('n6', 60);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toMatch(/5 recordings are being processed/);
    // One finishes: there's room again.
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    expect((await kickoff('n6', 60)).status).toBe(200);
  });
});

describe('one note holds at most the plan’s longest recording', () => {
  it('refuses a longer recording with 413, charging and queueing nothing', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' }); // Pro: 4 hours
    const out = await kickoff('long', 4 * 3600 + 61);
    expect(out).toMatchObject({ status: 413, body: { error: expect.stringMatching(/longer than 4 hours/) } });
    expect(await ledger()).toEqual([]);
    expect(enqueued).toHaveLength(0);
    expect(docs.get('workspaces/workspace_alice/notes/long')).toMatchObject({ status: 'error' });
    // Exactly the limit is fine.
    expect((await kickoff('max', 4 * 3600)).status).toBe(200);
  });

  // RELEASE.md rev 11, LM1 (H5a): a recording stopped at the limit claims a fraction over it.
  it('accepts a recording that hit the limit, up to a minute over, and charges the limit, not a minute more', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    expect((await kickoff('hit', 4 * 3600 + 0.3)).status).toBe(200);
    expect((await kickoff('hit2', 4 * 3600 + 60)).status).toBe(200);
    expect(await ledger()).toEqual(['hit debit 240 ingest', 'hit2 debit 240 ingest']);
  });
});

describe('the daily spend cap, at kickoff', () => {
  it('at the cap: 503 with the reason on the note, and nothing charged or queued', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    capped = true;
    const out = await kickoff('n1', 600);
    expect(out).toEqual({ status: 503, body: { error: SPEND_CAP_MESSAGE } });
    expect(await ledger()).toEqual([]);
    expect(enqueued).toHaveLength(0);
    expect(docs.get('workspaces/workspace_alice/notes/n1')).toMatchObject({ status: 'error', errorMessage: SPEND_CAP_MESSAGE });
    capped = false;
    expect((await kickoff('n1', 600)).status).toBe(200);
  });

  it("isn't applied to the notetaker's ingest (quota off): its minutes were reserved when the bot was sent", async () => {
    capped = true;
    // On the free floor (0 minutes): only a skipped quota check lets this queue.
    process.env.TRIAL_ON_FIRST_USE = 'off';
    await ensureTrial('alice', { platform: 'ios' });
    delete process.env.TRIAL_ON_FIRST_USE;
    await seedNote('rec', 'workspace_alice', 'alice');
    await pool.query(`UPDATE notes SET status = 'recording' WHERE id = 'rec'`);
    noteDoc('rec');
    const r = await queueNoteRun({
      firestore: fakeDb as never, noteId: 'rec', workspaceId: 'workspace_alice', uid: 'alice',
      type: 'online_meeting', storagePath: 'recordings/workspace_alice/rec.mp3', durationSec: 600,
      allowRecording: true, quota: false, usageBudget: false, log: quietLog,
    });
    expect(r.kind).toBe('queued');
    expect(spendChecks).toEqual([]);
  });
});

describe('noteChargeStands', () => {
  it('is true only while a charge is on the note and not refunded', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    expect(await noteChargeStands('n1', 'workspace_alice')).toBe(false); // never charged
    await kickoff('n1', 150);
    expect(await noteChargeStands('n1', 'workspace_alice')).toBe(true);
    await pool.query(
      `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
         SELECT uid, workspace_id, note_id, 'reversal', -minutes, billing_period, 'refund:test', 'n1:refund:test' FROM usage_ledger WHERE note_id = 'n1'`,
    );
    expect(await noteChargeStands('n1', 'workspace_alice')).toBe(false); // refunded
  });

  it("never reports on another workspace's note", async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    await kickoff('n1', 150);
    expect(await noteChargeStands('n1', 'workspace_bob')).toBe(false);
  });
});

// A client retry of a note stuck in flight (past IN_FLIGHT_STALE_MS) that is then
// refused must leave the note in flight: its run was charged, and the stuck-note
// sweep is what fails it and refunds that charge. Marking it `error` here, with no
// refund, would strand the charge for good.
describe('a refused retry of a stale in-flight note', () => {
  async function staleCharged(noteId: string) {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    expect((await kickoff(noteId, 150)).status).toBe(200);
    await pool.query(`UPDATE notes SET status = 'transcribing', updated_at = NOW() - INTERVAL '3 hours 40 minutes' WHERE id = $1`, [noteId]);
    docs.set(`workspaces/workspace_alice/notes/${noteId}`, { authorId: 'alice', status: 'transcribing' });
  }
  const stuck = async () => (await listStuckNotes({ olderThanMs: 3.5 * 60 * 60 * 1000 })).map((n) => n.noteId);

  it('at the spend cap: refused, but left in flight with its charge, for the sweep to fail and refund', async () => {
    await staleCharged('n1');
    capped = true;
    expect((await kickoff('n1', 150)).status).toBe(503);
    expect(await statusOf('n1')).toMatchObject({ status: 'transcribing' });
    expect(docs.get('workspaces/workspace_alice/notes/n1')).toMatchObject({ status: 'transcribing' });
    expect(await ledger()).toEqual(['n1 debit 3 ingest']);
    expect(await stuck()).toEqual(['n1']);
  });

  it('too long: the same', async () => {
    await staleCharged('n1');
    expect((await kickoff('n1', 5 * 3600)).status).toBe(413);
    expect(await statusOf('n1')).toMatchObject({ status: 'transcribing' });
    expect(await stuck()).toEqual(['n1']);
  });
});

// BLOCKERS: only the enqueue failure had a Postgres test for its refund.
describe('a kickoff that fails after the debit refunds it', () => {
  it('the mirror write fails after the commit: the note fails in Postgres and the charge comes back', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    failNextQueuedMirror = true;
    const out = await kickoff('n1', 150);
    expect(out.status).toBe(500);
    expect(await statusOf('n1')).toMatchObject({ status: 'error' });
    expect(await ledger()).toEqual(['n1 debit 3 ingest', 'n1 reversal -3 refund:enqueue_failed']);
    expect(enqueued).toHaveLength(0);
  });

  it('the transcoder config is missing: 503, the note fails and the charge comes back', async () => {
    await grantEntitlement({ uid: 'alice', reason: 'test' });
    delete process.env.TRANSCODER_URL;
    const out = await kickoff('n1', 150);
    expect(out).toMatchObject({ status: 503 });
    expect(await statusOf('n1')).toMatchObject({ status: 'error' });
    expect(await ledger()).toEqual(['n1 debit 3 ingest', 'n1 reversal -3 refund:enqueue_failed']);
  });
});
