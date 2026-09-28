import { describe, it, expect } from 'vitest';
import { MeetingBotResponse, CancelMeetingBotResponse, FeatureDisabledError } from '@algominutes/contracts/schemas';
// @ts-expect-error: plain ESM module, no type declarations
import { createMeetingRoutes, platformOf, periodStartOf, envCount } from '../services/api/src/routes/meetings.js';

// POST /v1/meetings/bots and /cancel (docs/plans/MEETINGS.md): allowlisted
// testers only, Google Meet only in M1, the link encrypted before anything is
// stored, and a retry of the same request healing a half-done one.
const ENV = { NOTETAKER: 'bot', NOTETAKER_MONTHLY_MINUTES: '300', NOTETAKER_MAX_ACTIVE: '5', MEETINGS_URL: 'https://meetings.example.run.app', MEETING_URL_KMS_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/meeting-url' };
const MEET = 'https://meet.google.com/abc-defg-hij';
const bot = (over: Record<string, unknown> = {}) => ({ id: '7f0e0c1a-0000-4000-8000-000000000001', uid: 'alice', workspaceId: 'workspace_alice', noteId: null, platform: 'google_meet', status: 'requested', cancelRequested: false, ...over });

function harness(over: { reserve?: any; createServerNote?: any; requestBotCancel?: any; enqueue?: any; encrypt?: any; env?: object } = {}) {
  const calls: any[] = [];
  const traces: string[] = [];
  const lines: any[] = [];
  const routes = createMeetingRoutes({
    env: { ...ENV, ...(over.env || {}) },
    firestore: () => ({}),
    crypto: { encrypt: over.encrypt ?? (async (url: string, id: string) => { calls.push(['encrypt', url, id]); return Buffer.from('ct'); }) },
    now: () => new Date('2026-09-28T10:00:00Z'),
    deps: {
      reserveMeetingBot: over.reserve ?? (async (input: any) => { calls.push(['reserve', input]); return { kind: 'reserved', bot: bot({ id: input.botId }) }; }),
      createServerNote: over.createServerNote ?? (async (_fs: unknown, input: any) => { calls.push(['note', input]); return { created: true }; }),
      requestBotCancel: over.requestBotCancel ?? (async () => bot({ status: 'scheduled', cancelRequested: true })),
      enqueue: over.enqueue ?? (async (kind: string, id: string, o: any) => { calls.push(['enqueue', kind, id, o.taskId]); traces.push(o.traceId); }),
      // notetaker_testers (migration 024): alice is a tester, bob isn't.
      isTester: async (uid: string) => uid === 'alice',
    },
  });
  async function call(fn: 'createMeetingBotRoute' | 'cancelMeetingBotRoute', { uid = 'alice', body = {}, params = {} }: any = {}) {
    let status = 0; let payload: any;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: any) => ((payload = b), res) };
    const logger = (bound: object): any => ({
      info: (o: object, msg: string) => lines.push({ level: 'info', msg, ...bound, ...o }),
      warn: (o: object, msg: string) => lines.push({ level: 'warn', msg, ...bound, ...o }),
      error: (o: object, msg: string) => lines.push({ level: 'error', msg, ...bound, ...o }),
      child: (b: object) => logger({ ...bound, ...b }),
    });
    const log = logger({ traceId: 't1', userId: uid });
    await routes[fn]({ uid, authEmail: `${uid}@x.test`, authName: 'Alice A', traceId: 't1', body, params, log }, res);
    return { status, payload };
  }
  return { calls, call, traces, lines };
}
const request = (over = {}) => ({ meetingUrl: MEET, requestId: 'req-12345678', title: 'Weekly sync', ...over });

describe('POST /v1/meetings/bots', () => {
  it('is 503 feature_disabled for anyone not allowlisted, or while switched off', async () => {
    const h = harness();
    const a = await h.call('createMeetingBotRoute', { uid: 'bob', body: request() });
    expect(a.status).toBe(503);
    expect(FeatureDisabledError.parse(a.payload)).toEqual(a.payload);
    const off = harness({ env: { NOTETAKER: '' } });
    expect((await off.call('createMeetingBotRoute', { body: request() })).status).toBe(503);
    expect(h.calls).toEqual([]);
  });

  it('encrypts the link bound to the new bot, reserves, creates the note, and sends the notetaker', async () => {
    const h = harness();
    const out = await h.call('createMeetingBotRoute', { body: request() });
    expect(out.status).toBe(202);
    expect(MeetingBotResponse.parse(out.payload)).toEqual(out.payload);
    const [enc, res, note, enq] = h.calls;
    expect(enc[0]).toBe('encrypt');
    expect(enc[1]).toBe(MEET);
    const botId = enc[2];
    expect(res[1]).toMatchObject({ botId, uid: 'alice', workspaceId: 'workspace_alice', requestId: 'req-12345678', platform: 'google_meet', allowanceMinutes: 300, maxMeetingMinutes: 240, maxActiveGlobal: 5, noticeVersion: 'notice-v1' });
    expect(Buffer.isBuffer(res[1].meetingUrlCiphertext)).toBe(true);
    expect(res[1].periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(note[1]).toMatchObject({ botId, noteId: out.payload.noteId, title: 'Weekly sync', sourceType: 'online_meeting', sourceKind: 'bot' });
    expect(enq).toEqual(['enqueue', 'create_bot', botId, `create-${botId}`]);
    expect(out.payload).toEqual({ botId, noteId: `mtg_${botId.replace(/-/g, '')}`, status: 'scheduled' });
  });

  it('a retry of the same request re-ensures the note and the task (heals a half-done first attempt)', async () => {
    const existing = bot();
    const h = harness({ reserve: async () => ({ kind: 'existing', bot: existing }) });
    const out = await h.call('createMeetingBotRoute', { body: request() });
    expect(out.status).toBe(202);
    expect(out.payload.botId).toBe(existing.id);
    expect(h.calls.filter((c) => c[0] === 'note').length).toBe(1);
    expect(h.calls.find((c) => c[0] === 'enqueue')).toEqual(['enqueue', 'create_bot', existing.id, `create-${existing.id}`]);
  });

  it('answers each refusal plainly', async () => {
    const cases: Array<[any, number]> = [
      [{ kind: 'duplicate_active', bot: bot({ status: 'joining' }) }, 409],
      [{ kind: 'too_many' }, 429],
      [{ kind: 'busy' }, 503],
      [{ kind: 'quota_exhausted', remainingMinutes: 5 }, 402],
    ];
    for (const [result, code] of cases) {
      const h = harness({ reserve: async () => result });
      const out = await h.call('createMeetingBotRoute', { body: request() });
      expect(out.status, result.kind).toBe(code);
      expect(h.calls.some((c) => c[0] === 'enqueue'), result.kind).toBe(false);
    }
  });

  it('only a Google Meet https link, and a real request id', async () => {
    const h = harness();
    expect((await h.call('createMeetingBotRoute', { body: request({ meetingUrl: 'https://zoom.us/j/123' }) })).payload.error).toMatch(/Google Meet/);
    expect((await h.call('createMeetingBotRoute', { body: request({ meetingUrl: 'http://meet.google.com/abc' }) })).status).toBe(400);
    expect((await h.call('createMeetingBotRoute', { body: request({ meetingUrl: 'https://example.com/x' }) })).status).toBe(400);
    expect((await h.call('createMeetingBotRoute', { body: { meetingUrl: MEET } })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('KMS down is a 503 before anything is stored; a failed enqueue is a 500 the client retries', async () => {
    const k = harness({ encrypt: async () => { throw new Error('kms 503'); } });
    expect((await k.call('createMeetingBotRoute', { body: request() })).status).toBe(503);
    expect(k.calls).toEqual([]);
    const e = harness({ enqueue: async () => { throw new Error('tasks 503'); } });
    expect((await e.call('createMeetingBotRoute', { body: request() })).status).toBe(500);
  });

  it('a request whose note was since deleted is 410, sends no bot, and stops one an earlier attempt queued', async () => {
    const h = harness({ reserve: async () => ({ kind: 'existing', bot: bot() }), createServerNote: async () => ({ created: false, deleted: true }) });
    expect((await h.call('createMeetingBotRoute', { body: request() })).status).toBe(410);
    expect(h.calls.filter((c) => c[0] === 'enqueue')).toEqual([['enqueue', 'cancel_bot', bot().id, `cancel-${bot().id}`]]);
  });
});

describe('POST /v1/meetings/bots: every failure is logged and recoverable', () => {
  it('the request\'s trace goes to the reservation and to the task, so one recording is followable end to end', async () => {
    const h = harness();
    await h.call('createMeetingBotRoute', { body: request() });
    expect(h.calls.find((c) => c[0] === 'reserve')[1].traceId).toBe('t1');
    expect(h.traces).toEqual(['t1']);
  });

  it('a live bot still "requested" from an earlier, half-done attempt is healed, not a 409 going nowhere', async () => {
    const stuck = bot({ status: 'requested' });
    const h = harness({ reserve: async () => ({ kind: 'duplicate_active', bot: stuck }) });
    const out = await h.call('createMeetingBotRoute', { body: request({ requestId: 'another-request' }) });
    expect(out.status).toBe(202);
    expect(out.payload.botId).toBe(stuck.id);
    expect(h.calls.map((c) => c[0])).toEqual(['encrypt', 'note', 'enqueue']);
    expect(h.lines.find((l) => l.msg === 'notetaker_requested')).toMatchObject({ healed: true, meetingBotId: stuck.id });
    // One already on its way (scheduled) is a plain 409.
    const busy = harness({ reserve: async () => ({ kind: 'duplicate_active', bot: bot({ status: 'scheduled' }) }) });
    expect((await busy.call('createMeetingBotRoute', { body: request() })).status).toBe(409);
    expect(busy.calls.some((c) => c[0] === 'enqueue')).toBe(false);
  });

  it('a note that can\'t be created is a logged 500 and sends nothing; the same request retried heals it', async () => {
    const h = harness({ createServerNote: async () => { throw new Error('firestore unavailable'); } });
    expect((await h.call('createMeetingBotRoute', { body: request() })).status).toBe(500);
    expect(h.calls.some((c) => c[0] === 'enqueue')).toBe(false);
    expect(h.lines.find((l) => l.msg === 'notetaker_note_create_failed')).toMatchObject({ level: 'error', traceId: 't1', userId: 'alice', workspaceId: 'workspace_alice' });
  });

  it('a tenancy mismatch, a deleted account and a database failure are each answered and logged', async () => {
    const cases: Array<[unknown, number, string]> = [
      [Object.assign(new Error('boundary'), { code: 'WORKSPACE_BOUNDARY' }), 403, 'notetaker_workspace_boundary'],
      [Object.assign(new Error('gone'), { code: 'ACCOUNT_DELETED' }), 401, 'notetaker_account_deleted'],
      [new Error('pg down'), 500, 'notetaker_reserve_failed'],
    ];
    for (const [err, code, msg] of cases) {
      const h = harness({ reserve: async () => { throw err; } });
      expect((await h.call('createMeetingBotRoute', { body: request() })).status, msg).toBe(code);
      expect(h.lines.find((l) => l.msg === msg), msg).toMatchObject({ traceId: 't1', userId: 'alice', workspaceId: 'workspace_alice' });
    }
  });
});

describe('POST /v1/meetings/bots/:botId/cancel', () => {
  it('asks the meetings service to cancel a live bot, and answers with its status', async () => {
    const h = harness();
    const id = bot().id;
    const out = await h.call('cancelMeetingBotRoute', { params: { botId: id } });
    expect(out.status).toBe(200);
    expect(CancelMeetingBotResponse.parse(out.payload)).toEqual(out.payload);
    expect(h.calls).toEqual([['enqueue', 'cancel_bot', id, `cancel-${id}`]]);
  });

  it('a finished bot, an unknown one, or a malformed id sends nothing', async () => {
    const done = harness({ requestBotCancel: async () => bot({ status: 'done' }) });
    expect((await done.call('cancelMeetingBotRoute', { params: { botId: bot().id } })).status).toBe(200);
    expect(done.calls).toEqual([]);
    const none = harness({ requestBotCancel: async () => null });
    expect((await none.call('cancelMeetingBotRoute', { params: { botId: bot().id } })).status).toBe(404);
    expect((await none.call('cancelMeetingBotRoute', { params: { botId: 'x' } })).status).toBe(404);
  });

  it('a database failure is a logged 500', async () => {
    const h = harness({ requestBotCancel: async () => { throw new Error('pg down'); } });
    expect((await h.call('cancelMeetingBotRoute', { params: { botId: bot().id } })).status).toBe(500);
    expect(h.lines.find((l) => l.msg === 'notetaker_cancel_failed')).toMatchObject({ level: 'error', meetingBotId: bot().id });
  });

  it('is 503 for anyone not allowlisted', async () => {
    const h = harness();
    expect((await h.call('cancelMeetingBotRoute', { uid: 'bob', params: { botId: bot().id } })).status).toBe(503);
  });
});

describe('configuration', () => {
  it('switched on without the meetings service or its key is off (503), and sends nothing', async () => {
    for (const missing of ['MEETINGS_URL', 'MEETING_URL_KMS_KEY']) {
      const h = harness({ env: { [missing]: '' } });
      const out = await h.call('createMeetingBotRoute', { body: request() });
      expect(out.status, missing).toBe(503);
      expect(h.calls, missing).toEqual([]);
    }
  });

  it('a count of 0 in the env means none, never the default', () => {
    expect(envCount('0', 600)).toBe(0);
    expect(envCount(undefined, 600)).toBe(600);
    expect(envCount('', 600)).toBe(600);
    for (const bad of ['-1', '1.5', 'many']) expect(envCount(bad, 600), bad).toBe(600);
    expect(envCount(' 42 ', 600)).toBe(42);
  });

  it('a cancel whose task can\'t be queued is a 500 the client retries', async () => {
    const h = harness({ enqueue: async () => { throw new Error('tasks 503'); } });
    const out = await h.call('cancelMeetingBotRoute', { params: { botId: '7f0e0c1a-0000-4000-8000-000000000001' } });
    expect(out.status).toBe(500);
  });
});

describe('meeting links', () => {
  it('names the platform from the host, https only', () => {
    expect(platformOf('https://meet.google.com/abc-defg-hij')).toBe('google_meet');
    expect(platformOf('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(platformOf('https://teams.microsoft.com/l/meetup-join/x')).toBe('teams');
    expect(platformOf('https://acme.webex.com/meet/x')).toBe('webex');
    expect(platformOf('https://evil-meet.google.com.example/x')).toBeNull();
    expect(platformOf('http://meet.google.com/x')).toBeNull();
    expect(platformOf('not a url')).toBeNull();
  });

  it('the allowance period is the UTC month', () => {
    expect(periodStartOf(new Date('2026-12-31T23:59:59Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
