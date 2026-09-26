import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, quietLog, noticeKinds } from './helpers';

// The "ready" and "failed" notices as an outbox (note-notices.cjs, migration
// 022): each is written in the transaction that makes the outcome, enqueued
// after it as a task named after the notice, re-enqueued by the sweep if that
// was lost, and sent by the notifier once. Real Postgres; Cloud Tasks, FCM and
// Firestore are fakes.
const require = createRequire(import.meta.url);
// The CommonJS code under test requires the TypeScript repo: give it this copy.
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const noteTerminal = require('@algominutes/db/note-terminal.cjs');
const pipelineRepo = require('@algominutes/db/pipeline-repo.cjs');
const cloudTasks = require('@algominutes/ai/cloud-tasks.cjs');
const { traceIdFromTask } = require('@algominutes/ai/logger.cjs');
const { noticeTaskId } = require('@algominutes/ai/notify.cjs');
const summarizer = require('../../services/summarizer/src/handler.js');
const sweep = require('../../services/db-job/src/handlers/sweep.js');
const { handleNotify } = require('../../services/notifier/src/handler.js');

const { getPool, markSummaryReady, markQueued, failStuckNote, claimNotice } = repo;

const errors: Array<{ o: any; m: string }> = [];
const log: any = {
  info: () => {}, warn: () => {},
  error: (o: any, m: string) => void errors.push({ o, m }),
  child: () => log,
};
const fsOk = { doc: () => ({ update: async () => {}, get: async () => ({ exists: true, data: () => ({}) }) }) } as never;

const ENV = { NOTIFIER_URL: 'https://notifier.example', TASKS_PROJECT: 'p', JOBS_SA_EMAIL: 'jobs@p.iam.gserviceaccount.com' };
const saved: Record<string, string | undefined> = {};
const originalEnqueue = cloudTasks.enqueueTask;
let enqueued: Array<{ taskId: string; payload: any; traceId: string }> = [];

beforeEach(async () => {
  await resetDb();
  errors.length = 0;
  enqueued = [];
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  cloudTasks.enqueueTask = async (a: any) => {
    enqueued.push({ taskId: a.taskId, payload: a.payload, traceId: a.traceId });
    return `tasks/${a.taskId}`;
  };
  await seedUser('alice');
  await seedWorkspace('ws', 'alice');
  await seedNote('n1', 'ws', 'alice');
  await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
});
afterEach(() => {
  cloudTasks.enqueueTask = originalEnqueue;
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(async () => {
  await summarizer.pool().end();
  await pool.end();
  await getPool().end();
});

const notices = async () =>
  (await pool.query(`SELECT id::text, kind, uid, run_seq, generation, trace_id, sent_at, abandoned_at FROM note_notices ORDER BY id`)).rows;
const fail = (over: Record<string, unknown> = {}) => noteTerminal.markNoteFailed({
  pool: getPool(), firestore: fsOk, noteId: 'n1', workspaceId: 'ws', message: 'It failed.', log, traceId: 'trace-1', ...over,
});

describe('a "failed" notice is written with the failure, once', () => {
  it("a new failure: one notice, enqueued after the commit under the recording's traceId, named after the notice", async () => {
    const outcome = await fail();
    expect(outcome.notice).toMatchObject({ kind: 'note_failed', noteId: 'n1', workspaceId: 'ws', uid: 'alice' });
    const [row] = await notices();
    expect(row).toMatchObject({ kind: 'note_failed', uid: 'alice', run_seq: 0, generation: 0, trace_id: 'trace-1', sent_at: null });
    expect(enqueued).toEqual([{
      taskId: noticeTaskId(row.id),
      payload: { type: 'note_failed', noteId: 'n1', workspaceId: 'ws', uid: 'alice', noticeId: row.id },
      traceId: 'trace-1',
    }]);
  });

  it('a caller with no traceId: the notice row and its task get the same new one', async () => {
    await fail({ traceId: null });
    const [row] = await notices();
    expect(row.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(enqueued.map((e) => e.traceId)).toEqual([row.trace_id]);
  });

  it('a replay of the same failure writes and enqueues nothing', async () => {
    await fail();
    const again = await fail();
    expect(again.notice).toBeNull();
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
    expect(enqueued).toHaveLength(1);
  });

  it('a note Postgres has as ready gets no "failed" notice', async () => {
    await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`);
    expect((await fail()).notice).toBeNull();
    expect(await noticeKinds('n1')).toEqual([]);
  });

  it("a re-run is a new outcome: markQueued starts a new run, and that run's failure is told too", async () => {
    await fail();
    const docs = new Set(['workspaces/ws/notes/n1']);
    const fs = { doc: (p: string) => ({ update: async () => { if (!docs.has(p)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 }); } }) } as never;
    expect(await markQueued(fs, { noteId: 'n1', workspaceId: 'ws', authorUid: 'alice', sourceType: 'recording' }, quietLog))
      .toMatchObject({ queued: true });
    await pool.query(`UPDATE notes SET status = 'transcribing' WHERE id = 'n1'`);
    await fail();
    expect((await notices()).map((n: any) => [n.kind, n.run_seq])).toEqual([['note_failed', 0], ['note_failed', 1]]);
  });

  it('the summarizer\'s "No speech was found" tells the author', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    const deps = { log, traceId: 'trace-5', sharedIntelligence: {}, sharedTemplates: {}, sharedRedaction: {}, geminiCall: {} };
    await summarizer.handle({ noteId: 'n1', workspaceId: 'ws' }, deps);
    expect(await noticeKinds('n1')).toEqual(['note_failed']);
    expect(enqueued.map((e) => [e.payload.type, e.traceId])).toEqual([['note_failed', 'trace-5']]);
  });

  it("the sweep's stuck-note failure tells the author", async () => {
    await pool.query(`UPDATE notes SET updated_at = NOW() - INTERVAL '5 hours' WHERE id = 'n1'`);
    const r = await failStuckNote(fsOk, {
      noteId: 'n1', workspaceId: 'ws', olderThanMs: 60_000, message: 'Stopped.', traceId: 'trace-sweep',
    }, log);
    expect(r).toMatchObject({ failed: true, notice: expect.objectContaining({ kind: 'note_failed' }) });
    expect(enqueued.map((e) => [e.payload.type, e.traceId])).toEqual([['note_failed', 'trace-sweep']]);
  });
});

describe('a "ready" notice is written with the summary, once', () => {
  const summary = (over: Record<string, unknown> = {}) => markSummaryReady(fsOk, {
    noteId: 'n1', workspaceId: 'ws', summary: { gist: 'g', actionItems: [], keyDecisions: [] },
    transcriptPreview: [], transcriptTruncated: false, expectedGeneration: 0, traceId: 'trace-2', ...over,
  }, log);

  it('the summary lands: one "ready" notice, enqueued; a replay of it adds none', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    expect(await summary()).toMatchObject({ written: true, notice: expect.objectContaining({ kind: 'note_ready' }) });
    expect(await summary()).toMatchObject({ written: true, notice: null });
    expect(await noticeKinds('n1')).toEqual(['note_ready']);
    expect(enqueued.map((e) => [e.payload.type, e.traceId])).toEqual([['note_ready', 'trace-2']]);
  });

  it('a regenerated summary is a new outcome, told again', async () => {
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    await summary();
    await pool.query(`UPDATE notes SET status = 'summarizing', summary_generation = 1 WHERE id = 'n1'`);
    await summary({ expectedGeneration: 1 });
    expect((await notices()).map((n: any) => [n.kind, n.generation])).toEqual([['note_ready', 0], ['note_ready', 1]]);
  });

  it("the fast path's short recording tells its author too (it never did)", async () => {
    const notice = await pipelineRepo.persistFastPathResult(getPool(), {
      noteId: 'n1', workspaceId: 'ws', model: 'm', traceId: 'trace-3',
      lines: [{ startMs: 0, text: 'Speaker 1: hi' }], summary: { gist: 'g', actionItems: [], keyDecisions: [] },
    }, log);
    expect(notice).toMatchObject({ kind: 'note_ready', noteId: 'n1' });
    expect(enqueued.map((e) => [e.payload.type, e.traceId])).toEqual([['note_ready', 'trace-3']]);
  });
});

describe('a notice whose enqueue was lost is sent anyway', () => {
  const runSweep = () => sweep.run({ log, env: {}, traceId: 't-sweep', deps: sweepFakes(), repo, noteTerminal });
  function sweepFakes() {
    const firestore = { doc: () => ({ update: async () => {}, delete: async () => {} }), recursiveDelete: async () => {}, collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) };
    return { firestore, bucket: { getFiles: async () => [[]] }, auth: { deleteUser: async () => {} } };
  }

  it("a crash between the commit and the enqueue: the sweep enqueues it, under the recording's traceId, as the same task", async () => {
    // The process died after the commit: nothing was enqueued.
    await fail({ enqueueNotice: async () => 'skipped' });
    expect(enqueued).toEqual([]);
    const [row] = await notices();
    await pool.query(`UPDATE note_notices SET created_at = NOW() - INTERVAL '10 minutes'`);
    const counts = await runSweep();
    expect(counts.notices).toEqual({ enqueued: 1, abandoned: 0, pruned: 0 });
    expect(enqueued).toEqual([{
      taskId: noticeTaskId(row.id),
      payload: expect.objectContaining({ type: 'note_failed', noticeId: row.id }),
      traceId: 'trace-1',
    }]);
  });

  it('the sweep leaves a notice minutes old to its writer, and a sent one alone', async () => {
    await fail({ enqueueNotice: async () => 'skipped' });
    expect((await runSweep()).notices).toEqual({ enqueued: 0, abandoned: 0, pruned: 0 });
    await pool.query(`UPDATE note_notices SET created_at = NOW() - INTERVAL '10 minutes', sent_at = NOW()`);
    expect((await runSweep()).notices).toEqual({ enqueued: 0, abandoned: 0, pruned: 0 });
  });

  it('a notice unsent for a day is given up and logged, not sent', async () => {
    await fail({ enqueueNotice: async () => 'skipped' });
    await pool.query(`UPDATE note_notices SET created_at = NOW() - INTERVAL '25 hours'`);
    expect((await runSweep()).notices).toEqual({ enqueued: 0, abandoned: 1, pruned: 0 });
    expect(enqueued).toEqual([]);
    expect((await notices())[0].abandoned_at).not.toBeNull();
    expect(errors).toContainEqual(expect.objectContaining({ m: 'notice_abandoned', o: expect.objectContaining({ noteId: 'n1', userId: 'alice' }) }));
  });

  it('notices done with for a month are pruned; recent and unsent ones stay', async () => {
    await fail({ enqueueNotice: async () => 'skipped' });
    await pool.query(`UPDATE note_notices SET created_at = NOW() - INTERVAL '40 days', sent_at = NOW() - INTERVAL '31 days'`);
    await pool.query(`UPDATE notes SET status = 'summarizing' WHERE id = 'n1'`);
    await markSummaryReady(fsOk, {
      noteId: 'n1', workspaceId: 'ws', summary: { gist: 'g', actionItems: [], keyDecisions: [] },
      transcriptPreview: [], transcriptTruncated: false, expectedGeneration: 0, traceId: 'trace-2',
    }, log);
    expect((await runSweep()).notices).toEqual({ enqueued: 0, abandoned: 0, pruned: 1 });
    expect(await noticeKinds('n1')).toEqual(['note_ready']);
  });
});

describe('the notifier sends each notice once', () => {
  async function aNotice() {
    await fail({ enqueueNotice: async () => 'skipped' });
    const [row] = await notices();
    return { type: 'note_failed', noteId: 'n1', workspaceId: 'ws', uid: 'alice', noticeId: row.id, traceId: 'trace-1' };
  }
  function notifier({ tokens = ['tok-1'], sendFails = 0 } = {}) {
    const sends: any[] = [];
    let failuresLeft = sendFails;
    const deps = {
      log, traceIdFromTask, tokensForUser: async () => tokens.map((token) => ({ token, platform: 'ios' })),
      deletePushToken: async () => {},
      messaging: () => ({
        sendEachForMulticast: async (m: any) => {
          if (failuresLeft-- > 0) throw new Error('FCM unreachable');
          sends.push(m);
          return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) };
        },
      }),
      claimNotice: repo.claimNotice, markNoticeSent: repo.markNoticeSent, releaseNotice: repo.releaseNotice,
    };
    return { sends, deliver: (body: any) => handleNotify(body, {}, deps) };
  }

  it('a second delivery of a sent notice sends nothing', async () => {
    const body = await aNotice();
    const n = notifier();
    expect((await n.deliver(body)).status).toBe(200);
    expect(await n.deliver(body)).toEqual({ status: 200, json: { ok: true, sent: 0, reason: 'notice_sent' } });
    expect(n.sends).toHaveLength(1);
    expect(n.sends[0].data).toEqual({ type: 'note_failed', noteId: 'n1', deepLink: 'algominutes://note/n1' });
    expect((await notices())[0].sent_at).not.toBeNull();
  });

  it('a delivery while another holds the notice sends nothing', async () => {
    const body = await aNotice();
    expect(await claimNotice(body.noticeId)).toMatchObject({ claimed: true });
    const n = notifier();
    expect((await n.deliver(body)).json).toMatchObject({ sent: 0, reason: 'notice_claimed' });
    expect(n.sends).toEqual([]);
  });

  it('a send that fails lets go of the notice, and the retry sends it', async () => {
    const body = await aNotice();
    const n = notifier({ sendFails: 1 });
    expect((await n.deliver(body)).status).toBe(500);
    expect((await n.deliver(body)).status).toBe(200);
    expect(n.sends).toHaveLength(1);
  });

  it("a notice from an earlier run is never sent: the note was re-queued since, and it's given up", async () => {
    const body = await aNotice();
    await pool.query(`UPDATE notes SET run_seq = run_seq + 1, status = 'transcribing' WHERE id = 'n1'`);
    const n = notifier();
    expect((await n.deliver(body)).json).toMatchObject({ sent: 0, reason: 'notice_superseded' });
    expect(n.sends).toEqual([]);
    expect((await notices())[0].abandoned_at).not.toBeNull();
  });

  it("a deleted note's notice is never sent", async () => {
    const body = await aNotice();
    await pool.query(`DELETE FROM notes WHERE id = 'n1'`);
    const n = notifier();
    expect((await n.deliver(body)).json).toMatchObject({ sent: 0, reason: 'notice_gone' });
    expect(n.sends).toEqual([]);
  });

  it('with no device to send to, the notice counts as sent', async () => {
    const body = await aNotice();
    const n = notifier({ tokens: [] });
    expect((await n.deliver(body)).json).toMatchObject({ sent: 0, reason: 'no_tokens' });
    expect((await n.deliver(body)).json).toMatchObject({ reason: 'notice_sent' });
  });

  it('a task from before the outbox (no noticeId) is still sent; a malformed id is refused', async () => {
    const n = notifier();
    expect((await n.deliver({ type: 'note_ready', noteId: 'n1', workspaceId: 'ws', uid: 'alice' })).status).toBe(200);
    expect(n.sends).toHaveLength(1);
    expect((await n.deliver({ type: 'note_ready', noteId: 'n1', workspaceId: 'ws', uid: 'alice', noticeId: '1; DROP' })).status).toBe(400);
  });
});
