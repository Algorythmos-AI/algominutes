import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM modules, no type declarations
import { createReconcileTasks, reconcileTaskId, RECONCILE_EVERY_MS, MEDIA_GIVE_UP_MS } from '../services/meetings/src/tasks/reconcile.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { RecallError } from '../services/meetings/src/lib/recall-client.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { ingestTaskId } from '../services/meetings/src/tasks/notetaker.js';

// The notetaker's reconcile (RELEASE.md PR 21): every 15 minutes it picks up work whose own task was lost. Against
// fakes of Recall and the repo: what each step re-drives or ends, the task names that keep two runs from
// doubling it, and one item's failure never stopping the rest.
const NOW = Date.parse('2026-09-30T10:07:00Z');
const WINDOW = Math.floor(NOW / RECONCILE_EVERY_MS);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const bot = (id: string, over: object = {}) => ({
  id, uid: 'alice', workspaceId: 'workspace_alice', noteId: `mtg_${id}`, recallBotId: `recall-${id}`,
  status: 'call_ended', statusRank: 60, traceId: `trace-${id}`, audioReady: false, participantsReady: false,
  ...over,
});
const doneRecording = { media_shortcuts: {
  audio_mixed: { status: { code: 'done' }, data: { download_url: 'https://media.recall.ai/a' } },
  participant_events: { status: { code: 'done' }, data: {} },
} };

function world() {
  const calls: string[] = [];
  const lists: Record<string, any[]> = { events: [], requested: [], stalled: [], quiet: [] };
  const remote: Record<string, any> = {};
  const recall: any = {
    getBot: async (id: string) => {
      calls.push(`recall:get:${id}`);
      if (remote[id] instanceof Error) throw remote[id];
      return remote[id] ?? { recordings: [], status_changes: [] };
    },
  };
  const repo: any = {
    listUnprocessedRecallEvents: async () => lists.events,
    listStaleRequestedBots: async () => lists.requested,
    listStalledNotetakers: async () => lists.stalled,
    listQuietLiveBots: async () => lists.quiet,
    markBotMediaReady: async (id: string, what: string) => { calls.push(`ready:${id}:${what}`); },
    advanceNotetaker: async (_fs: unknown, input: any) => { calls.push(`advance:${input.botId}:${input.status}`); return { changed: true }; },
    failNotetaker: async (_fs: unknown, input: any) => {
      calls.push(`fail:${input.botId}:${input.status}:${input.failureReason}`);
      return { changed: true, bot: {} };
    },
  };
  const enqueue = async (kind: string, payload: any, opts: any) => {
    calls.push(`enqueue:${kind}:${payload.meetingBotId ?? payload.recallEventId}:${opts.traceId}`);
    if (opts.taskId) calls.push(`name:${opts.taskId}`);
  };
  const tasks = createReconcileTasks({ getRecall: async () => recall, getFirestore: () => ({}), enqueue, repo, now: () => NOW });
  const lines: any[] = [];
  const logger = (bound: object): any => ({
    info: (o: object, msg: string) => lines.push({ level: 'info', msg, ...bound, ...o }),
    warn: (o: object, msg: string) => lines.push({ level: 'warn', msg, ...bound, ...o }),
    error: (o: object, msg: string) => lines.push({ level: 'error', msg, ...bound, ...o }),
    child: (b: object) => logger({ ...bound, ...b }),
  });
  let body: any = null;
  const run = async () => {
    let status = 0;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: any) => ((body = b), res) };
    await tasks.reconcile({ body: { traceId: 'tick-trace' }, headers: {}, log: logger({}) }, res);
    return status;
  };
  return { calls, lists, remote, repo, run, lines, body: () => body };
}

describe('reconcile', () => {
  it('re-drives lost webhooks and bots never sent, each under a name for this run', async () => {
    const w = world();
    w.lists.events = [{ id: 41, event: 'bot.done' }];
    w.lists.requested = [bot('b1', { status: 'requested', statusRank: 0, recallBotId: null })];
    expect(await w.run()).toBe(200);
    expect(w.calls).toEqual([
      'enqueue:process_event:41:tick-trace', `name:${reconcileTaskId('event', 41, WINDOW)}`,
      'enqueue:create_bot:b1:trace-b1', `name:${reconcileTaskId('create', 'b1', WINDOW)}`,
    ]);
    expect(w.body()).toMatchObject({ ok: true, events: 1, creates: 1 });
    expect(w.lines.find((l) => l.msg === 'notetaker_create_redriven')).toMatchObject({ traceId: 'trace-b1', taskTraceId: 'tick-trace', meetingBotId: 'b1', userId: 'alice', noteId: 'mtg_b1' });
  });

  it('a recording with both media in has its lost ingest enqueued again', async () => {
    const w = world();
    w.lists.stalled = [bot('b2', { audioReady: true, participantsReady: true, endedAt: ago(50 * 60_000) })];
    await w.run();
    // Under the ingest's own name, so one still retrying isn't doubled.
    expect(w.calls).toEqual(['enqueue:ingest:b2:trace-b2', `name:${ingestTaskId('b2')}`]);
  });

  it('one whose webhooks never came is asked of Recall: a finished recording is marked ready and ingested', async () => {
    const w = world();
    w.lists.stalled = [bot('b3', { audioReady: true, endedAt: ago(50 * 60_000) })];
    w.remote['recall-b3'] = { recordings: [doneRecording] };
    await w.run();
    expect(w.calls).toEqual(['recall:get:recall-b3', 'ready:b3:audio', 'ready:b3:participants', 'enqueue:ingest:b3:trace-b3', `name:${ingestTaskId('b3')}`]);
    expect(w.body()).toMatchObject({ mediaFound: 1 });
  });

  it('a recording whose note was deleted meanwhile has its ingest re-driven to take the meeting with it, media or not', async () => {
    const w = world();
    w.lists.stalled = [bot('b8', { noteId: null, endedAt: ago(50 * 60_000) })];
    await w.run();
    expect(w.calls).toEqual(['enqueue:ingest:b8:trace-b8', `name:${ingestTaskId('b8')}`]);
    expect(w.lines.find((l) => l.msg === 'notetaker_deleted_meeting_redriven')).toMatchObject({ meetingBotId: 'b8' });
  });

  it('one Recall is still processing is left for the next run', async () => {
    const w = world();
    w.lists.stalled = [bot('b4', { endedAt: ago(50 * 60_000) })];
    w.remote['recall-b4'] = { recordings: [{ media_shortcuts: { audio_mixed: { status: { code: 'processing' } } } }] };
    await w.run();
    expect(w.calls).toEqual(['recall:get:recall-b4']);
  });

  it('six hours on with no media, the note fails, Recall is no longer asked, and it alerts', async () => {
    const w = world();
    w.lists.stalled = [bot('b5', { endedAt: ago(MEDIA_GIVE_UP_MS + 60_000) })];
    await w.run();
    expect(w.calls).toEqual(['fail:b5:failed:error']);
    expect(w.lines.find((l) => l.msg === 'notetaker_media_never_arrived')).toMatchObject({ level: 'error', meetingBotId: 'b5', traceId: 'trace-b5' });
  });

  it('a bot silent for hours is asked of Recall: ended unrecorded fails with its reason, recorded moves on, still there waits', async () => {
    const w = world();
    w.lists.quiet = [
      bot('q1', { status: 'waiting_room', statusRank: 30 }),
      bot('q2', { status: 'in_call', statusRank: 40 }),
      bot('q3', { status: 'joining', statusRank: 20 }),
    ];
    w.remote['recall-q1'] = { recordings: [], status_changes: [{ code: 'joining_call' }, { code: 'call_ended', sub_code: 'timeout_exceeded_waiting_room' }] };
    w.remote['recall-q2'] = { recordings: [{ started_at: '2026-09-30T06:00:00Z' }], status_changes: [{ code: 'in_call_recording' }, { code: 'done', created_at: '2026-09-30T07:00:00Z' }] };
    w.remote['recall-q3'] = { recordings: [], status_changes: [{ code: 'in_waiting_room' }] };
    await w.run();
    expect(w.calls).toEqual([
      'recall:get:recall-q1', 'fail:q1:failed:not_admitted',
      'recall:get:recall-q2', 'advance:q2:call_ended',
      'recall:get:recall-q3',
    ]);
    expect(w.body()).toMatchObject({ quietEnded: 2 });
  });

  it('one item failing is logged with its ids, the rest still run, and the run answers 500', async () => {
    const w = world();
    w.lists.stalled = [bot('bad', { endedAt: ago(50 * 60_000) }), bot('good', { audioReady: true, participantsReady: true, endedAt: ago(50 * 60_000) })];
    w.remote['recall-bad'] = new RecallError('recall GET: HTTP 503', { status: 503 });
    expect(await w.run()).toBe(500);
    expect(w.calls).toContain('enqueue:ingest:good:trace-good');
    expect(w.lines.find((l) => l.msg === 'notetaker_reconcile_item_failed')).toMatchObject({ level: 'error', meetingBotId: 'bad', noteId: 'mtg_bad', traceId: 'trace-bad' });
    expect(w.body()).toMatchObject({ ok: false, failed: 1, ingests: 1 });
  });

  it('a quiet bot Recall has no record of ended without recording', async () => {
    const w = world();
    w.lists.quiet = [bot('q9', { status: 'joining', statusRank: 20 })];
    w.remote['recall-q9'] = new RecallError('recall GET: HTTP 404', { status: 404 });
    expect(await w.run()).toBe(200);
    expect(w.calls).toEqual(['recall:get:recall-q9', 'fail:q9:failed:error']);
    expect(w.lines.find((l) => l.msg === 'notetaker_quiet_bot_unknown_to_recall')).toMatchObject({ level: 'warn', meetingBotId: 'q9' });
  });

  it('a step that can\'t read its list is logged and counted, and the later steps still run', async () => {
    const w = world();
    w.repo.listStaleRequestedBots = async () => { throw new Error('pg down'); };
    w.lists.stalled = [bot('b6', { audioReady: true, participantsReady: true, endedAt: ago(50 * 60_000) })];
    expect(await w.run()).toBe(500);
    expect(w.calls).toContain('enqueue:ingest:b6:trace-b6');
    expect(w.lines.find((l) => l.msg === 'notetaker_reconcile_step_failed')).toMatchObject({ level: 'error', step: 'requested', traceId: 'tick-trace' });
  });

  it('a lost webhook that fails says which event and which bot', async () => {
    const w = world();
    w.lists.events = [{ id: 41, event: 'bot.done', meetingBotId: 'b7', recallBotId: 'recall-b7' }];
    // The queue refuses this run's enqueue.
    const failing = createReconcileTasks({ getRecall: async () => ({}), getFirestore: () => ({}), repo: w.repo, now: () => NOW, enqueue: async () => { throw new Error('tasks 503'); } });
    const lines: any[] = [];
    const log: any = { info: () => {}, warn: () => {}, error: (o: any, m: string) => lines.push({ m, ...o }), child: () => log };
    const res: any = { status: () => res, json: () => res };
    await failing.reconcile({ body: {}, headers: {}, log }, res);
    expect(lines.find((l) => l.m === 'notetaker_reconcile_item_failed')).toMatchObject({ step: 'events', recallEventId: 41, meetingBotId: 'b7', recallBotId: 'recall-b7' });
  });

  it('nothing to do asks nothing of Recall', async () => {
    const w = world();
    expect(await w.run()).toBe(200);
    expect(w.calls).toEqual([]);
    expect(w.lines.find((l) => l.msg === 'notetaker_reconciled')).toMatchObject({ traceId: 'tick-trace', events: 0, failed: 0 });
  });
});

describe('reconcileTaskId', () => {
  it('is the same within a window, new in the next, and a valid Cloud Tasks name', () => {
    expect(reconcileTaskId('ingest', 'b1', 7)).toBe(reconcileTaskId('ingest', 'b1', 7));
    expect(reconcileTaskId('ingest', 'b1', 8)).not.toBe(reconcileTaskId('ingest', 'b1', 7));
    expect(reconcileTaskId('create', 'b1', 7)).not.toBe(reconcileTaskId('ingest', 'b1', 7));
    expect(reconcileTaskId('event', 41, 7)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    expect(reconcileTaskId('ingest', '7f0e0c1a-0000-4000-8000-000000000001', 1_970_000)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });
});
