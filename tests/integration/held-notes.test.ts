import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getPool, grantEntitlement, resumeHeldNotes, queueNoteRun, markQueued } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// RELEASE.md rev 11, H6b: a note held for minutes is queued once its author has them, through the real kickoff
// (metering, the trial, the queue state) against real Postgres. Only Firestore (the mirror), Cloud Tasks and the
// Firestore rate-limit counter are faked.
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
const fakeDb: any = { doc: docRef, collection: () => ({ add: async () => ({}) }) };
vi.mock('firebase-admin/firestore', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFirestore: () => fakeDb,
}));
const enqueued: Array<Record<string, unknown>> = [];
let enqueueFails = false;
vi.mock('@algominutes/ai/cloud-tasks.cjs', () => ({
  default: {
    enqueueTask: async ({ payload }: { payload: Record<string, unknown> }) => {
      if (enqueueFails) throw new Error('tasks 503');
      enqueued.push(payload);
    },
  },
}));
let budgetCalls = 0;
vi.mock('@algominutes/ai/intelligence.cjs', async (importOriginal) => {
  const real = ((await importOriginal()) as { default: Record<string, unknown> }).default;
  return { default: { ...real, enforceUsageBudget: async () => { budgetCalls += 1; } } };
});

const env = { ...process.env, TRANSCODER_URL: 'https://transcoder.invalid', JOBS_SA_EMAIL: 'jobs@example.invalid', TASKS_PROJECT: 'test-project' };
const noop = () => {};
const said: string[] = [];
const log: any = { info: (_o: unknown, m: string) => void said.push(m), warn: (_o: unknown, m: string) => void said.push(m), error: (_o: unknown, m: string) => void said.push(m) };
log.child = () => log;
void noop;

beforeEach(async () => {
  await resetDb();
  docs.clear();
  enqueued.length = 0;
  enqueueFails = false;
  budgetCalls = 0;
  said.length = 0;
  await seedUser('alice');
  await seedWorkspace('ws', 'alice');
  await grantEntitlement({ uid: 'alice', reason: 'test', includedMinutes: 10 });
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

/** A note the transcoder held: measured `minutes` long, its first run's charge reversed, mirrored as held. */
async function held(noteId: string, minutes: number, heldAgoMin: number, workspaceId = 'ws', uid = 'alice') {
  await seedNote(noteId, workspaceId, uid);
  await pool.query(
    `UPDATE notes SET status = 'awaiting_minutes', source_type = 'recording', storage_path = $2, mime_type = 'audio/mp4',
            duration_sec_probed = $3, updated_at = NOW() - ($4::int * INTERVAL '1 minute') WHERE id = $1`,
    [noteId, `recordings/${workspaceId}/${noteId}.m4a`, minutes * 60, heldAgoMin],
  );
  await pool.query(
    `INSERT INTO usage_ledger (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
       VALUES ($1, $2, $3, 'debit', $4, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM'), 'ingest', $3 || ':ingest'),
              ($1, $2, $3, 'reversal', -$4, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM'), 'refund:held_for_minutes', $3 || ':refund:held')`,
    [uid, workspaceId, noteId, minutes],
  );
  docs.set(`workspaces/${workspaceId}/notes/${noteId}`, { status: 'awaiting_minutes', authorId: uid });
}
const status = async (noteId: string) => (await pool.query(`SELECT status FROM notes WHERE id = $1`, [noteId])).rows[0].status;
const net = async (noteId: string) => Number((await pool.query(`SELECT COALESCE(SUM(minutes), 0)::float8 AS n FROM usage_ledger WHERE note_id = $1`, [noteId])).rows[0].n);
const resume = () => resumeHeldNotes({ firestore: fakeDb, log, traceId: 't-resume', env });

describe('resumeHeldNotes', () => {
  it('minutes cover it: queued through the kickoff, charged its measured length, the kickoff enqueued', async () => {
    await held('n1', 8, 30);
    expect(await resume()).toEqual({ held: 1, resumed: 1, waiting: 0, leftHeld: 0 });
    expect(await status('n1')).toBe('queued');
    expect(await net('n1')).toBe(8);
    expect(enqueued).toEqual([expect.objectContaining({ kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', uid: 'alice', storagePath: 'recordings/ws/n1.m4a', mimeType: 'audio/mp4' })]);
    expect(docs.get('workspaces/ws/notes/n1')).toMatchObject({ status: 'queued' });
    // The user's hourly budget isn't spent on a resume they didn't ask for.
    expect(budgetCalls).toBe(0);
  });

  it("minutes don't cover it: left held, nothing written or enqueued", async () => {
    await held('n1', 20, 30);
    expect(await resume()).toEqual({ held: 1, resumed: 0, waiting: 1, leftHeld: 0 });
    expect(await status('n1')).toBe('awaiting_minutes');
    expect(await net('n1')).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('oldest first: a newer, shorter note never jumps an older one still waiting', async () => {
    await held('old', 20, 60);
    await held('new', 5, 10);
    expect(await resume()).toEqual({ held: 2, resumed: 0, waiting: 1, leftHeld: 0 });
    expect(await status('new')).toBe('awaiting_minutes');
    // Minutes arrive (an invite redeemed): both fit now, and both go, oldest first.
    await grantEntitlement({ uid: 'alice', reason: 'invite', includedMinutes: 30 });
    expect(await resume()).toEqual({ held: 2, resumed: 2, waiting: 0, leftHeld: 0 });
    expect(enqueued.map((p) => p.noteId)).toEqual(['old', 'new']);
    expect([await net('old'), await net('new')]).toEqual([20, 5]);
  });

  it('as many as the minutes cover, then the rest wait', async () => {
    await held('a', 6, 60);
    await held('b', 6, 30);
    expect(await resume()).toEqual({ held: 2, resumed: 1, waiting: 1, leftHeld: 0 });
    expect([await status('a'), await status('b')]).toEqual(['queued', 'awaiting_minutes']);
  });

  it('a second sweep changes nothing: the resumed note is in flight, charged once', async () => {
    await held('n1', 8, 30);
    await resume();
    expect(await resume()).toEqual({ held: 0, resumed: 0, waiting: 0, leftHeld: 0 });
    expect(await net('n1')).toBe(8);
    expect(enqueued).toHaveLength(1);
  });

  it("an enqueue that fails holds the note again, refunded, for the next sweep", async () => {
    await held('n1', 8, 30);
    enqueueFails = true;
    expect(await resume()).toEqual({ held: 1, resumed: 0, waiting: 0, leftHeld: 1 });
    expect(await status('n1')).toBe('awaiting_minutes');
    expect(await net('n1')).toBe(0);
    expect(said).toContain('resume_failed_held_again');
    expect(said).not.toContain('note_failed');
    // Its measured length is kept for the next resume (markQueued cleared it for the run).
    expect(Number((await pool.query(`SELECT duration_sec_probed FROM notes WHERE id = 'n1'`)).rows[0].duration_sec_probed)).toBe(8 * 60);
    enqueueFails = false;
    expect(await resume()).toMatchObject({ resumed: 1 });
    expect(await net('n1')).toBe(8);
  });

  it("an author no longer in the workspace isn't resumed there", async () => {
    await seedUser('bob');
    await seedWorkspace('ws-b', 'bob');
    await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ('ws-b', 'alice', 'member')`);
    await held('n1', 5, 30, 'ws-b', 'alice');
    await pool.query(`DELETE FROM workspace_members WHERE workspace_id = 'ws-b' AND uid = 'alice'`);
    expect(await resume()).toEqual({ held: 0, resumed: 0, waiting: 0, leftHeld: 0 });
    expect(await status('n1')).toBe('awaiting_minutes');
  });

  // Found by dual-write-auditor: the sweep works from a list, and a client may run the note meanwhile.
  it.each(['ready', 'error', 'queued'])("a note run to '%s' since the sweep listed it isn't queued again, nor charged", async (since) => {
    await held('n1', 8, 30);
    const runSince = async (k: any) => {
      await pool.query(`UPDATE notes SET status = $1, updated_at = NOW() - INTERVAL '4 hours' WHERE id = 'n1'`, [since]);
      return queueNoteRun(k);
    };
    const r = await resumeHeldNotes({ firestore: fakeDb, log, traceId: 't-resume', env, queue: runSince });
    expect(r).toEqual({ held: 1, resumed: 0, waiting: 0, leftHeld: 1 });
    expect(await status('n1')).toBe(since);
    expect(await net('n1')).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it('markQueued, asked to take only a held note, leaves any other alone (the check under the lock)', async () => {
    await seedNote('n2', 'ws', 'alice');
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n2'`);
    docs.set('workspaces/ws/notes/n2', { status: 'ready' });
    const out = await markQueued(fakeDb, { noteId: 'n2', workspaceId: 'ws', authorUid: 'alice', sourceType: 'recording', onlyIfHeld: true, meter: { minutes: 1, idempotencyKey: 'n2:ingest', enforceQuota: true } }, log);
    expect(out).toEqual({ queued: false, status: 'ready' });
    expect(await status('n2')).toBe('ready');
    expect(await net('n2')).toBe(0);
  });

  it('a deleted held note is never resumed', async () => {
    await held('n1', 5, 30);
    await pool.query(`UPDATE notes SET deleted_at = NOW() WHERE id = 'n1'`);
    expect(await resume()).toEqual({ held: 0, resumed: 0, waiting: 0, leftHeld: 0 });
    expect(enqueued).toEqual([]);
  });
});
