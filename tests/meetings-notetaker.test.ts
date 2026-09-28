import { describe, it, expect, beforeEach, vi } from 'vitest';
// @ts-expect-error: plain ESM modules, no type declarations
import { createNotetakerTasks } from '../services/meetings/src/tasks/notetaker.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { actionFor, failureReasonFor, FAILURE_MESSAGES } from '../services/meetings/src/lib/recall-events.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { botNameFor, noticeFor, NOTICE_VERSION } from '../services/meetings/src/lib/notice.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { RecallError, botCreateParams } from '../services/meetings/src/lib/recall-client.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { createRecallWebhookRoute } from '../services/meetings/src/webhooks/recall.js';
import crypto from 'node:crypto';

// The notetaker's tasks in services/meetings (docs/plans/MEETINGS.md), against
// fakes of Recall, the repo, KMS and Firestore: adopt-or-create, never two
// bots, cancel before and after recording, and every webhook mapped to one
// forward-only action. Nothing is charged when nothing was recorded.
const RANK = { requested: 0, scheduled: 10, joining: 20, waiting_room: 30, in_call: 40, recording: 50, call_ended: 60, processing: 70, done: 100, failed: 100, cancelled: 100 } as const;
type Status = keyof typeof RANK;

function world(over: Partial<{ status: Status; recallBotId: string | null; cancelRequested: boolean; ciphertext: Buffer | null }> = {}) {
  const bot: any = {
    id: '7f0e0c1a-0000-4000-8000-000000000001', uid: 'alice', workspaceId: 'workspace_alice', noteId: 'mtg_7f0e', platform: 'google_meet',
    status: over.status ?? 'requested', statusRank: RANK[over.status ?? 'requested'], recallBotId: over.recallBotId ?? null,
    cancelRequested: over.cancelRequested ?? false, reservedMinutes: 90, traceId: 'trace-1', failureReason: null,
  };
  const calls: string[] = [];
  const recall: any = {
    found: [] as any[],
    createBot: async (params: any, key: string) => { calls.push(`create:${key}`); recall.lastParams = params; return { id: 'recall-new' }; },
    findBotsByMetadata: async (k: string, v: string) => { calls.push(`find:${k}=${v}`); return recall.found; },
    deleteBot: async (id: string) => { calls.push(`delete:${id}`); if (recall.deleteFails) throw new RecallError('delete', { status: recall.deleteFails === true ? 405 : recall.deleteFails }); return null; },
    leaveCall: async (id: string) => { calls.push(`leave:${id}`); if (recall.leaveFails) throw new RecallError('leave', { status: recall.leaveFails }); return null; },
    getBot: async (id: string) => { calls.push(`get:${id}`); return recall.remote ?? { id, recordings: [], status_changes: [] }; },
  };
  const events: any[] = [];
  const repo: any = {
    BOT_STATUS_RANK: RANK,
    getMeetingBotById: async () => ({ ...bot }),
    getMeetingBotByRecallId: async (id: string) => (bot.recallBotId === id ? { ...bot } : null),
    getRecallEvent: async (id: number) => events.find((e) => e.id === id) ?? null,
    markRecallEventProcessed: async (id: number) => { calls.push(`processed:${id}`); const e = events.find((x) => x.id === id); if (e) e.processed = true; },
    attachRecallBot: async (_id: string, rid: string) => {
      if (RANK[bot.status as Status] >= 100) return { attached: false, recallBotId: bot.recallBotId, terminal: true };
      if (bot.recallBotId && bot.recallBotId !== rid) return { attached: false, recallBotId: bot.recallBotId, terminal: false };
      bot.recallBotId = rid; bot.status = 'scheduled'; bot.statusRank = RANK.scheduled; calls.push(`attach:${rid}`);
      return { attached: true, recallBotId: rid, terminal: false };
    },
    advanceNotetaker: async (_fs: unknown, { status, failureReason }: { status: Status; failureReason?: string }) => {
      if (RANK[bot.status as Status] >= 100 || RANK[status] <= bot.statusRank) return { changed: false, bot };
      bot.status = status; bot.statusRank = RANK[status]; if (failureReason) bot.failureReason = failureReason;
      calls.push(`status:${status}${failureReason ? `:${failureReason}` : ''}`);
      return { changed: true, bot };
    },
    // The repo's one-transaction ending: bot terminal (first ending wins), note failed, purge queued once.
    failNotetaker: async (_fs: unknown, { status, failureReason, messageFor }: { status: 'failed' | 'cancelled'; failureReason: string | null; messageFor: (s: string, r: string | null) => string }) => {
      if (repo.failThrows) { const e = repo.failThrows; repo.failThrows = null; throw e; }
      let changed = false;
      if (RANK[bot.status as Status] < 100) {
        bot.status = status; bot.statusRank = 100; bot.failureReason = status === 'failed' ? failureReason : null; changed = true;
        calls.push(`status:${status}${status === 'failed' && failureReason ? `:${failureReason}` : ''}`);
        if (bot.recallBotId) calls.push(`purge:${bot.recallBotId}`);
      }
      if (bot.status === 'failed' || bot.status === 'cancelled') calls.push(`note_error:${messageFor(bot.status, bot.failureReason)}`);
      return { changed, bot: { ...bot } };
    },
    enqueueRecallPurge: async (_c: unknown, { recallBotId }: { recallBotId: string }) => { calls.push(`purge:${recallBotId}`); },
    getBotMeetingUrlCiphertext: async () => (over.ciphertext === undefined ? Buffer.from('ct') : over.ciphertext),
    getBotOwnerName: async () => 'Sam Kalaliya',
    recordConsentEvent: async (_id: string, c: object) => { calls.push(`consent:${Object.keys(c).sort().join(',')}`); },
    markBotMediaReady: async (_id: string, what: string) => { calls.push(`media:${what}`); return { audioReady: what === 'audio', participantsReady: what === 'participants' }; },
    confirmRecallPurge: async (id: string) => { calls.push(`confirmed:${id}`); },
  };
  const tasks = createNotetakerTasks({
    getRecall: async () => recall,
    getCrypto: () => ({ decrypt: async (_ct: Buffer, boundTo: string) => { calls.push(`decrypt:${boundTo}`); return 'https://meet.google.com/abc-defg-hij'; } }),
    getFirestore: () => ({}),
    env: { ALGOMINUTES_ENV: 'staging' },
    repo,
  });
  // Every line as it would ship: the child bindings merged under the call's own fields.
  const lines: any[] = [];
  const logger = (bound: object): any => ({
    info: (o: object, msg: string) => lines.push({ level: 'info', msg, ...bound, ...o }),
    warn: (o: object, msg: string) => lines.push({ level: 'warn', msg, ...bound, ...o }),
    error: (o: object, msg: string) => lines.push({ level: 'error', msg, ...bound, ...o }),
    child: (b: object) => logger({ ...bound, ...b }),
  });
  const run = async (kind: string, body: object, headers: Record<string, string> = {}) => {
    let status = 0;
    const res: any = { status: (s: number) => ((status = s), res), json: () => res };
    await tasks[kind]({ body, headers, log: logger({ traceId: 'dispatch-trace' }) }, res);
    return status;
  };
  return { bot, calls, recall, repo, events, run, lines };
}

describe('create_bot', () => {
  it('creates one Recall bot with our settings and our id as the idempotency key, then records it', async () => {
    const w = world();
    expect(await w.run('create_bot', { meetingBotId: w.bot.id })).toBe(200);
    expect(w.calls).toEqual([`find:meeting_bot_id=${w.bot.id}`, `decrypt:${w.bot.id}`, `create:${w.bot.id}`, 'attach:recall-new']);
    expect(w.recall.lastParams).toMatchObject({
      meeting_url: 'https://meet.google.com/abc-defg-hij',
      bot_name: "Sam's notetaker (AlgoMinutes)",
      metadata: { meeting_bot_id: w.bot.id, workspace_id: 'workspace_alice', env: 'staging' },
      recording_config: { audio_mixed_mp3: {}, video_mixed_mp4: null, retention: { type: 'timed', hours: 72 } },
      automatic_leave: { waiting_room_timeout: 600, noone_joined_timeout: 600, recording_permission_denied_timeout: 30, in_call_recording_timeout: 5400 },
      chat: { on_bot_join: { send_to: 'everyone', pin: true } },
    });
  });

  it('a replay adopts the bot Recall already made (found by our id), and removes any extra', async () => {
    const w = world();
    w.recall.found = [{ id: 'recall-a' }, { id: 'recall-b' }];
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual([`find:meeting_bot_id=${w.bot.id}`, 'delete:recall-b', 'attach:recall-a']);
    expect(w.calls.some((c) => c.startsWith('create:'))).toBe(false);
  });

  it('a Recall bot that isn\'t the one we already have is removed, never left to join untracked', async () => {
    const w = world({ recallBotId: 'recall-old', status: 'scheduled' });
    w.repo.getMeetingBotById = async () => ({ ...w.bot, recallBotId: null });
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toContain('delete:recall-new');
  });

  it('a link Recall refuses fails the note in words the user can act on, and is not retried', async () => {
    const w = world();
    w.recall.createBot = async () => { throw new RecallError('bad', { status: 400 }); };
    expect(await w.run('create_bot', { meetingBotId: w.bot.id })).toBe(200);
    expect(w.calls).toContain('status:failed:meeting_not_found');
    expect(w.calls).toContain(`note_error:${FAILURE_MESSAGES.meeting_not_found}`);
  });

  it('a busy Recall (507) is retried; on the last attempt the note says so instead of waiting forever', async () => {
    const w = world();
    w.recall.createBot = async () => { throw new RecallError('busy', { status: 507, retryAfterSeconds: 60 }); };
    await expect(w.run('create_bot', { meetingBotId: w.bot.id })).rejects.toThrow(/busy/);
    expect(w.calls.some((c) => c.startsWith('status:failed'))).toBe(false);
    process.env.MAX_TASK_ATTEMPTS = '5';
    expect(await w.run('create_bot', { meetingBotId: w.bot.id }, { 'x-cloudtasks-taskretrycount': '4' })).toBe(200);
    expect(w.calls).toContain('status:failed:error');
    delete process.env.MAX_TASK_ATTEMPTS;
  });

  it('a cancel that came first stops it before Recall is asked', async () => {
    const w = world({ cancelRequested: true });
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls.some((c) => c.startsWith('create:'))).toBe(false);
    expect(w.calls).toContain('status:cancelled');
    expect(w.calls).toContain(`note_error:${FAILURE_MESSAGES.cancelled}`);
  });

  it('a finished or unknown bot is left alone', async () => {
    const w = world({ status: 'done' });
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual([]);
  });

  it('a link already cleared (never expected) fails cleanly rather than creating a bot with no meeting', async () => {
    const w = world({ ciphertext: null });
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toContain('status:failed:error');
    expect(w.calls.some((c) => c.startsWith('create:'))).toBe(false);
  });
});

describe('cancel_bot', () => {
  it('before Recall has the bot: cancelled, and create_bot then stops', async () => {
    const w = world();
    await w.run('cancel_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual(['status:cancelled', `note_error:${FAILURE_MESSAGES.cancelled}`]);
  });

  it('before the recording starts: the bot is removed (leave when it can no longer be deleted) and the note ends', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'waiting_room' });
    w.recall.deleteFails = true;
    await w.run('cancel_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual(['delete:recall-1', 'leave:recall-1', 'status:cancelled', 'purge:recall-1', `note_error:${FAILURE_MESSAGES.cancelled}`]);
  });

  it('once recording: the bot only leaves, and what it recorded becomes the note', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'recording' });
    await w.run('cancel_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual(['leave:recall-1']);
  });
});

describe('process_event', () => {
  const ev = (event: string, extra: object = {}) => ({ id: 1, meetingBotId: '7f0e0c1a-0000-4000-8000-000000000001', recallBotId: 'recall-1', event, subCode: null, occurredAt: new Date('2026-09-28T01:00:00Z'), processed: false, ...extra });

  it('recording: the status moves on and the consent record notes the admission and the notice', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'in_call' });
    w.events.push(ev('bot.in_call_recording'));
    await w.run('process_event', { recallEventId: 1 });
    expect(w.calls).toEqual(['consent:admittedAt,noticeSentAt', 'status:recording', 'processed:1']);
  });

  it('a call that ends before it ever recorded fails the note as not admitted, with nothing charged', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'waiting_room' });
    w.events.push(ev('bot.call_ended', { subCode: 'timeout_exceeded_waiting_room' }));
    await w.run('process_event', { recallEventId: 1 });
    // Confirmed with Recall first: the recording's own event could still be on its way.
    expect(w.calls).toEqual(['get:recall-1', 'status:failed:not_admitted', 'purge:recall-1', `note_error:${FAILURE_MESSAGES.not_admitted}`, 'processed:1']);
  });

  it('a call that ends after recording is the normal end', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'recording' });
    w.events.push(ev('bot.call_ended'));
    await w.run('process_event', { recallEventId: 1 });
    expect(w.calls).toEqual(['status:call_ended', 'processed:1']);
  });

  it('Google blocking the bot, and a host denying recording, each say why', async () => {
    const a = world({ recallBotId: 'recall-1', status: 'joining' });
    a.events.push(ev('bot.fatal', { subCode: 'google_meet_bot_blocked' }));
    await a.run('process_event', { recallEventId: 1 });
    expect(a.calls).toContain('status:failed:bot_blocked');
    const b = world({ recallBotId: 'recall-1', status: 'in_call' });
    b.events.push(ev('bot.recording_permission_denied'));
    await b.run('process_event', { recallEventId: 1 });
    expect(b.calls.slice(0, 2)).toEqual(['consent:recordingPermission', 'status:failed:permission_denied']);
  });

  it('the media events mark the bot ready for ingest, and Recall\'s delete confirmation closes the purge', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'call_ended' });
    w.events.push(ev('audio_mixed.done'), { ...ev('recording.deleted'), id: 2 });
    await w.run('process_event', { recallEventId: 1 });
    await w.run('process_event', { recallEventId: 2 });
    expect(w.calls).toEqual(['media:audio', 'processed:1', 'confirmed:recall-1', 'processed:2']);
  });

  it('an event already processed, or for a bot that isn\'t ours, changes nothing (and the latter is closed)', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'in_call' });
    w.events.push({ ...ev('bot.in_call_recording'), processed: true }, { ...ev('bot.joining_call'), id: 2, meetingBotId: null, recallBotId: 'someone-else' });
    w.repo.getMeetingBotById = async () => null;
    await w.run('process_event', { recallEventId: 1 });
    await w.run('process_event', { recallEventId: 2 });
    expect(w.calls).toEqual(['processed:2']);
  });
});

describe('the event table', () => {
  it('maps sub-codes to reasons the user can act on, and anything unknown to a plain error', () => {
    expect(failureReasonFor('timeout_exceeded_waiting_room')).toBe('not_admitted');
    expect(failureReasonFor('bot_kicked_from_waiting_room')).toBe('not_admitted');
    expect(failureReasonFor('timeout_exceeded_noone_joined')).toBe('not_admitted');
    expect(failureReasonFor('google_meet_bot_blocked')).toBe('bot_blocked');
    expect(failureReasonFor('meeting_not_found')).toBe('meeting_not_found');
    expect(failureReasonFor('recording_permission_denied')).toBe('permission_denied');
    expect(failureReasonFor('something_new')).toBe('error');
    expect(failureReasonFor(null)).toBe('error');
  });

  it('a done or fatal before recording fails; a done after recording is ignored (ingest waits for the media events)', () => {
    expect(actionFor({ event: 'bot.done' }, { statusRank: 20 })).toMatchObject({ kind: 'fail' });
    expect(actionFor({ event: 'bot.done' }, { statusRank: 60 })).toEqual({ kind: 'ignore' });
    expect(actionFor({ event: 'something.new' }, { statusRank: 0 })).toEqual({ kind: 'ignore' });
    expect(actionFor({ event: 'audio_mixed.failed' }, { statusRank: 60 })).toEqual({ kind: 'media_failed' });
  });
});

describe('what the meeting sees', () => {
  it('the bot is "{First name}\'s notetaker (AlgoMinutes)", within 100 characters, suffix always there', () => {
    expect(botNameFor('Sam Kalaliya')).toBe("Sam's notetaker (AlgoMinutes)");
    expect(botNameFor('')).toBe('Notetaker (AlgoMinutes)');
    const long = botNameFor('X'.repeat(300));
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith(' (AlgoMinutes)')).toBe(true);
  });

  it('the notice says what is happening and for whom, links the explainer, and never claims it is lawful', () => {
    const n = noticeFor('Sam Kalaliya');
    expect(n).toContain("Sam's notetaker from AlgoMinutes");
    expect(n).toContain('recording and transcribing');
    expect(n).toContain('https://algominutes.algorythmos.com/notetaker');
    expect(n).not.toMatch(/lawful|legal|compliant|consent (has been|was) (given|obtained)/i);
    expect(n.length).toBeLessThan(4096);
    expect(NOTICE_VERSION).toMatch(/^notice-v\d+$/);
  });

  it('the in-call time limit is the reservation', () => {
    expect(botCreateParams({ meetingUrl: 'u', botName: 'b', meetingBotId: 'm', workspaceId: 'w', env: 'e', reservedMinutes: 15, notice: 'n' }).automatic_leave.in_call_recording_timeout).toBe(900);
  });
});

describe('the webhook hands each event to process_event', () => {
  const KEY = crypto.randomBytes(24);
  const SECRET = `whsec_${KEY.toString('base64')}`;
  const NOW = 1_800_000_000_000;
  const BODY = JSON.stringify({ event: 'bot.joining_call', data: { bot: { id: 'r1', metadata: { meeting_bot_id: 'm1', env: 'staging' } }, data: { code: 'joining_call' } } });
  const sign = () => {
    const ts = String(Math.floor(NOW / 1000));
    return { 'webhook-id': 'msg_9', 'webhook-timestamp': ts, 'webhook-signature': `v1,${crypto.createHmac('sha256', KEY).update(`msg_9.${ts}.${BODY}`).digest('base64')}` };
  };
  async function deliver(stored: { inserted: boolean; id: number; processed: boolean }, enqueue: (x: any) => Promise<unknown>) {
    const r = createRecallWebhookRoute({ readSecret: async () => SECRET, env: { ALGOMINUTES_ENV: 'staging' }, now: () => NOW, record: async () => stored, enqueue });
    let status = 0;
    const res: any = { status: (s: number) => ((status = s), res), json: () => res };
    const log: any = { info() {}, warn() {}, error() {} };
    await r({ body: Buffer.from(BODY), headers: sign(), log, traceId: 't' }, res);
    return status;
  }

  it('a new event is enqueued; a redelivery of a processed one is not; one never processed is, again', async () => {
    const seen: number[] = [];
    const enqueue = async ({ recallEventId }: { recallEventId: number }) => { seen.push(recallEventId); };
    expect(await deliver({ inserted: true, id: 5, processed: false }, enqueue)).toBe(200);
    expect(await deliver({ inserted: false, id: 5, processed: true }, enqueue)).toBe(200);
    expect(await deliver({ inserted: false, id: 5, processed: false }, enqueue)).toBe(200);
    expect(seen).toEqual([5, 5]);
  });

  it('if the enqueue fails, 503: Recall redelivers, and it runs then', async () => {
    expect(await deliver({ inserted: true, id: 6, processed: false }, async () => { throw new Error('tasks 503'); })).toBe(503);
  });
});

describe('event task names', () => {
  it('one stable, valid name per stored event, never sharing a sequential prefix', async () => {
    // @ts-expect-error: plain ESM module, no type declarations
    const { eventTaskId } = await import('../services/meetings/src/app.js');
    expect(eventTaskId(41)).toBe(eventTaskId('41'));
    expect(eventTaskId(41)).not.toBe(eventTaskId(42));
    for (const id of [1, 41, 9007199254740991]) expect(eventTaskId(id)).toMatch(/^evt-[0-9a-f]{12}-\d+$/);
    // Consecutive ids don't share the characters after "evt-".
    expect(eventTaskId(41).slice(4, 8)).not.toBe(eventTaskId(42).slice(4, 8));
  });
});

describe('failures are never half-done, and never mistaken', () => {
  const ev = (event: string, extra: object = {}) => ({ id: 1, meetingBotId: '7f0e0c1a-0000-4000-8000-000000000001', recallBotId: 'recall-1', event, subCode: null, occurredAt: new Date('2026-09-28T01:00:00Z'), processed: false, ...extra });

  it('an ending that fails partway is retried in full; a replay on a failed bot finishes its mirror', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'waiting_room' });
    w.events.push(ev('bot.call_ended', { subCode: 'timeout_exceeded_waiting_room' }));
    w.repo.failThrows = new Error('firestore unavailable');
    await expect(w.run('process_event', { recallEventId: 1 })).rejects.toThrow('firestore unavailable');
    expect(w.calls).not.toContain('processed:1');
    expect(w.lines.find((l) => l.msg === 'process_event_attempt_failed')).toMatchObject({ level: 'warn', traceId: 'trace-1', meetingBotId: w.bot.id });
    await w.run('process_event', { recallEventId: 1 });
    expect(w.calls.filter((c) => c.startsWith('status:'))).toEqual(['status:failed:not_admitted']);
    expect(w.calls).toContain('processed:1');
    // A create_bot replay days later: the bot is failed; only the mirror is finished again.
    w.calls.length = 0;
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual([`note_error:${FAILURE_MESSAGES.not_admitted}`]);
  });

  it('an ending that arrives before its recording event is checked with Recall, and a real recording is kept', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'in_call' });
    w.recall.remote = { id: 'recall-1', recordings: [{ id: 'rec-1', started_at: '2026-09-28T00:05:00Z' }], status_changes: [{ code: 'in_call_recording', created_at: '2026-09-28T00:05:00Z' }] };
    w.events.push(ev('bot.call_ended', { subCode: 'everyone_left' }));
    await w.run('process_event', { recallEventId: 1 });
    expect(w.calls).toEqual(['get:recall-1', 'status:call_ended', 'processed:1']);
    expect(w.calls.some((c) => c.startsWith('purge:') || c.startsWith('note_error:'))).toBe(false);
    expect(w.lines.some((l) => l.msg === 'notetaker_recorded_out_of_order')).toBe(true);
  });

  it('our key or region being wrong (401/403) is retried and alerts, never fails the user\'s note as a bad link', async () => {
    const w = world();
    w.recall.createBot = async () => { throw new RecallError('create', { status: 401 }); };
    await expect(w.run('create_bot', { meetingBotId: w.bot.id })).rejects.toThrow();
    expect(w.calls.some((c) => c.startsWith('status:failed'))).toBe(false);
    expect(w.lines.find((l) => l.msg === 'recall_auth_failed')).toMatchObject({ level: 'error', status: 401 });
  });

  it('only "not in a call" or "no such bot" counts as gone; any other refusal to leave is retried', async () => {
    const gone = world({ recallBotId: 'recall-1', status: 'recording' });
    gone.recall.leaveFails = 400;
    expect(await gone.run('cancel_bot', { meetingBotId: gone.bot.id })).toBe(200);
    const denied = world({ recallBotId: 'recall-1', status: 'recording' });
    denied.recall.leaveFails = 403;
    await expect(denied.run('cancel_bot', { meetingBotId: denied.bot.id })).rejects.toThrow();
    expect(denied.lines.find((l) => l.msg === 'recall_auth_failed')).toMatchObject({ level: 'error', recallBotId: 'recall-1' });
    expect(denied.lines.some((l) => l.msg === 'notetaker_asked_to_leave')).toBe(false);
  });

  it('a delete Recall answers 404 is already gone; a 403 is a fault, never taken for removed', async () => {
    const gone = world({ recallBotId: 'recall-1', status: 'scheduled' });
    gone.recall.deleteFails = 404;
    await gone.run('cancel_bot', { meetingBotId: gone.bot.id });
    expect(gone.calls).toEqual(['delete:recall-1', 'status:cancelled', 'purge:recall-1', `note_error:${FAILURE_MESSAGES.cancelled}`]);
    const denied = world({ recallBotId: 'recall-1', status: 'scheduled' });
    denied.recall.deleteFails = 403;
    await expect(denied.run('cancel_bot', { meetingBotId: denied.bot.id })).rejects.toThrow();
    expect(denied.calls).toEqual(['delete:recall-1']);
  });

  it('a duplicate bot a replay made leaves, and what it recorded is queued for deletion', async () => {
    const w = world();
    w.recall.found = [{ id: 'recall-a' }, { id: 'recall-b' }];
    w.recall.deleteFails = true; // already dispatched (405): it must leave
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual(expect.arrayContaining(['delete:recall-b', 'leave:recall-b', 'purge:recall-b', 'attach:recall-a']));
  });
});

describe('what the notetaker logs', () => {
  it('a refused link is logged without the link, under the trace of the request that sent the bot', async () => {
    const w = world();
    const refusal = new RecallError('recall POST /api/v1/bot/: HTTP 400', { status: 400, body: '{"meeting_url":["https://meet.google.com/abc-defg-hij is invalid"]}' });
    w.recall.createBot = async () => { throw refusal; };
    await w.run('create_bot', { meetingBotId: w.bot.id, traceId: 'task-trace' });
    expect(JSON.stringify(w.lines)).not.toMatch(/meet\.google\.com|abc-defg-hij/);
    // And through the real logger, byte for byte as it ships.
    const { makeLogger } = await import('@algominutes/ai/logger.cjs' as string);
    const out: string[] = [];
    const spies = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
    for (const spy of spies) spy.mockImplementation(((chunk: string) => { out.push(String(chunk)); return true; }) as any);
    try {
      makeLogger({ service: 'meetings' }).child({ traceId: 'trace-1' }).warn({ err: refusal, status: 400 }, 'recall_bot_refused');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(out.join('')).toContain('recall_bot_refused');
    expect(out.join('')).not.toMatch(/meet\.google\.com|abc-defg-hij/);
    const refused = w.lines.find((l) => l.msg === 'recall_bot_refused');
    expect(refused).toMatchObject({ traceId: 'trace-1', userId: 'alice', workspaceId: 'workspace_alice', noteId: 'mtg_7f0e', meetingBotId: w.bot.id, platform: 'google_meet' });
  });

  it('a webhook\'s task keeps its own trace alongside the recording\'s; an unknown bot is logged under the task\'s', async () => {
    const w = world({ recallBotId: 'recall-1', status: 'in_call' });
    w.events.push({ id: 1, meetingBotId: w.bot.id, recallBotId: 'recall-1', event: 'bot.in_call_recording', subCode: null, occurredAt: new Date(), processed: false });
    await w.run('process_event', { recallEventId: 1, traceId: 'webhook-trace' });
    expect(w.lines.find((l) => l.msg === 'recall_event_processed')).toMatchObject({ traceId: 'trace-1', taskTraceId: 'webhook-trace' });
    const u = world();
    u.repo.getMeetingBotById = async () => null;
    await u.run('create_bot', { meetingBotId: 'not-a-uuid', traceId: 'task-trace' });
    expect(u.lines.find((l) => l.msg === 'create_bot_unknown')).toMatchObject({ traceId: 'task-trace', meetingBotId: 'invalid' });
    // A malformed carried trace is never taken.
    await u.run('cancel_bot', { meetingBotId: 'x', traceId: 'bad trace\n' });
    expect(u.lines.find((l) => l.msg === 'cancel_bot_unknown')?.traceId).not.toBe('bad trace\n');
  });
});

describe('a bot never joins a meeting it has no business in', () => {
  it('a cancel that lands while Recall makes the bot: the new Recall bot is removed, not attached', async () => {
    const w = world();
    w.recall.createBot = async (_p: any, key: string) => {
      w.calls.push(`create:${key}`);
      // The user cancels meanwhile: cancel_bot finds no Recall bot yet and ends ours.
      w.bot.status = 'cancelled'; w.bot.statusRank = 100;
      return { id: 'recall-late' };
    };
    expect(await w.run('create_bot', { meetingBotId: w.bot.id })).toBe(200);
    expect(w.calls).toEqual(expect.arrayContaining(['delete:recall-late']));
    expect(w.calls.some((c) => c.startsWith('attach:'))).toBe(false);
    expect(w.lines.some((l) => l.msg === 'create_bot_ended_meanwhile')).toBe(true);
  });

  it('a replay of an ended bot finds and removes any Recall bot a crashed attempt made', async () => {
    const w = world({ status: 'cancelled' });
    w.recall.found = [{ id: 'recall-orphan' }];
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls).toEqual(expect.arrayContaining(['find:meeting_bot_id=' + w.bot.id, 'delete:recall-orphan']));
  });

  it('a bot whose note was deleted is never sent', async () => {
    const w = world();
    w.bot.noteId = null;
    await w.run('create_bot', { meetingBotId: w.bot.id });
    expect(w.calls.some((c) => c.startsWith('create:'))).toBe(false);
    expect(w.calls).toContain('status:cancelled');
  });
});
