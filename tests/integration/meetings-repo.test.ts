import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getPool,
  reserveMeetingBot, advanceBotStatus, attachRecallBot, requestBotCancel, recordRecallEvent,
  markRecallEventProcessed, listUnprocessedRecallEvents,
  markBotMediaReady, saveMeetingSpeakers, markBotIngested, getMeetingBot, getMeetingBotById,
  enqueueRecallPurge, listPendingRecallPurges, listExhaustedRecallPurges, recordRecallPurgeAttempt, confirmRecallPurge,
  createServerNote, advanceNotetaker, deleteNote, noteIdForBot, meetingUrlHash, toNotetakerStatus, getSpeakerSegments,
  WorkspaceBoundaryError,
} from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, count, quietLog } from './helpers';

// The notetaker's data layer (migration 023, meetings-repo.ts, createServerNote,
// advanceNotetaker) against real Postgres. The rules under test: one bot gives
// one note in one workspace, for members only; replays and out-of-order
// webhooks change nothing; minutes are reserved under a lock; a deleted note
// never comes back.
const docs = new Map<string, Record<string, unknown>>();
let onCreate: ((path: string) => Promise<void>) | null = null;
function docRef(path: string) {
  const ref = {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async create(v: Record<string, unknown>) {
      if (docs.has(path)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${path}`), { code: 6 });
      docs.set(path, v);
      if (onCreate) await onCreate(path);
    },
    async set(v: Record<string, unknown>) { docs.set(path, v); },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() { docs.delete(path); },
  };
  return ref;
}
const fakeDb = {
  doc: docRef,
  // Sequential stand-in for a Firestore transaction: read, decide, write.
  async runTransaction(fn: (tx: any) => Promise<unknown>) {
    return fn({ get: (r: any) => r.get(), update: (r: any, v: any) => r.update(v) });
  },
} as never;

const MEET = 'https://meet.google.com/abc-defg-hij';
const periodStart = new Date(Date.now() - 24 * 3600 * 1000);
const reserve = (over: Partial<Parameters<typeof reserveMeetingBot>[0]> = {}) => reserveMeetingBot({
  botId: randomUUID(), uid: 'alice', workspaceId: 'workspace_alice', requestId: randomUUID(),
  platform: 'google_meet', meetingUrl: MEET, allowanceMinutes: 600, periodStart,
  maxMeetingMinutes: 240, maxActiveGlobal: 100, noticeVersion: 'notice-v1', traceId: 't1', ...over,
}, quietLog);
const botOf = (r: Awaited<ReturnType<typeof reserve>>) => (r as { bot: { id: string } }).bot;
const noteInput = (botId: string, over: Record<string, unknown> = {}) => ({
  botId, noteId: noteIdForBot(botId), workspaceId: 'workspace_alice', uid: 'alice', title: 'Weekly sync',
  sourceType: 'online_meeting' as const, sourceKind: 'bot' as const, platform: 'google_meet',
  notetaker: { botId, status: 'scheduled', platform: 'google_meet' }, ...over,
});
const docOf = (botId: string) => docs.get(`workspaces/workspace_alice/notes/${noteIdForBot(botId)}`) as any;

beforeEach(async () => {
  await resetDb();
  docs.clear();
  onCreate = null;
  for (const u of ['alice', 'bob']) {
    await seedUser(u);
    await seedWorkspace(`workspace_${u}`, u);
  }
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('reserving a notetaker', () => {
  it('reserves minutes, records the notice version, and the same request returns the same bot', async () => {
    const requestId = randomUUID();
    const first = await reserve({ requestId });
    expect(first.kind).toBe('reserved');
    expect(botOf(first)).toMatchObject({ status: 'requested', reservedMinutes: 240, uid: 'alice', workspaceId: 'workspace_alice' });
    expect(await count(`SELECT 1 FROM meeting_consents WHERE meeting_bot_id = $1 AND notice_version = 'notice-v1'`, [botOf(first).id])).toBe(1);
    expect(await reserve({ requestId })).toMatchObject({ kind: 'existing', bot: { id: botOf(first).id } });
    expect(await count('SELECT 1 FROM meeting_bots')).toBe(1);
  });

  it('refuses a caller who is not a member of the workspace, before reading anything in it', async () => {
    const a = await reserve();
    await expect(reserve({ uid: 'bob' })).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect(await count('SELECT 1 FROM meeting_bots')).toBe(1);
    // And bob can't look alice's bot up, even with the right ids.
    expect(await getMeetingBot(botOf(a).id, 'workspace_alice', 'bob')).toBeNull();
    expect(await getMeetingBot(botOf(a).id, 'workspace_alice', 'alice')).not.toBeNull();
  });

  it('refuses a second live bot on the same meeting in the same workspace (tracking query and slash ignored)', async () => {
    const a = await reserve();
    expect(await reserve({ meetingUrl: `${MEET}/?authuser=1` })).toMatchObject({ kind: 'duplicate_active', bot: { id: botOf(a).id } });
  });

  it('another workspace in the same meeting gets its own bot (never a share of this one)', async () => {
    const a = await reserve();
    const b = await reserve({ uid: 'bob', workspaceId: 'workspace_bob' });
    expect([a.kind, b.kind]).toEqual(['reserved', 'reserved']);
    expect(botOf(a).id).not.toBe(botOf(b).id);
    expect(await getMeetingBot(botOf(a).id, 'workspace_bob', 'bob')).toBeNull();
  });

  it('caps live bots per user and globally', async () => {
    await reserve({ meetingUrl: 'https://meet.google.com/aaa-aaaa-aaa' });
    await reserve({ meetingUrl: 'https://meet.google.com/bbb-bbbb-bbb' });
    expect((await reserve({ meetingUrl: 'https://meet.google.com/ccc-cccc-ccc' })).kind).toBe('too_many');
    expect((await reserve({ uid: 'bob', workspaceId: 'workspace_bob', maxActiveGlobal: 2 })).kind).toBe('busy');
  });

  it('holds minutes while live; counts a recording by its length however it ended; releases one that recorded nothing', async () => {
    const a = await reserve({ allowanceMinutes: 300 });
    expect(botOf(a).reservedMinutes).toBe(240);
    const b = await reserve({ allowanceMinutes: 300, meetingUrl: 'https://meet.google.com/bbb-bbbb-bbb' });
    expect(botOf(b).reservedMinutes).toBe(60);
    await advanceBotStatus(botOf(b).id, 'failed', { failureReason: 'not_admitted' });   // released: 0
    await markBotIngested(botOf(a).id, 30 * 60);
    await advanceBotStatus(botOf(a).id, 'cancelled');                                     // recorded 30, then cancelled: still 30
    const c = await reserve({ allowanceMinutes: 300, meetingUrl: 'https://meet.google.com/ccc-cccc-ccc' });
    expect(botOf(c).reservedMinutes).toBe(240);
    await advanceBotStatus(botOf(c).id, 'done');                                          // done without a recording: 0
    const d = await reserve({ allowanceMinutes: 280, meetingUrl: 'https://meet.google.com/ddd-dddd-ddd' });
    expect(botOf(d).reservedMinutes).toBe(240);
    expect(await reserve({ allowanceMinutes: 280, meetingUrl: 'https://meet.google.com/eee-eeee-eee' }))
      .toEqual({ kind: 'quota_exhausted', remainingMinutes: 10 });
  });

  it('two requests at once for the same meeting: one bot, not two (the locks)', async () => {
    const [x, y] = await Promise.all([reserve(), reserve()]);
    expect([x.kind, y.kind].sort()).toEqual(['duplicate_active', 'reserved']);
    expect(await count('SELECT 1 FROM meeting_bots')).toBe(1);
  });
});

describe('a bot\'s status', () => {
  it('only moves forward, a terminal status is final, and the meeting link is forgotten once in the call', async () => {
    const id = botOf(await reserve({ meetingUrlCiphertext: Buffer.from('secret') })).id;
    expect(await attachRecallBot(id, 'recall-1')).toEqual({ attached: true, recallBotId: 'recall-1' });
    expect((await advanceBotStatus(id, 'recording')).changed).toBe(true);
    expect((await advanceBotStatus(id, 'joining')).changed).toBe(false); // a late webhook
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND meeting_url_ciphertext IS NULL`, [id])).toBe(1);
    expect((await advanceBotStatus(id, 'done')).changed).toBe(true);
    expect((await advanceBotStatus(id, 'failed', { failureReason: 'error' })).changed).toBe(false);
    expect((await getMeetingBotById(id))?.status).toBe('done');
  });

  it('a second Recall bot is never silently attached (the caller must remove it)', async () => {
    const id = botOf(await reserve()).id;
    await attachRecallBot(id, 'recall-1');
    expect(await attachRecallBot(id, 'recall-2')).toEqual({ attached: false, recallBotId: 'recall-1' });
    expect(await attachRecallBot(id, 'recall-1')).toEqual({ attached: true, recallBotId: 'recall-1' });
  });

  it('cancel: the sender, or a workspace owner or admin, and only on a live bot', async () => {
    await pool.query(`INSERT INTO workspace_members (workspace_id, uid, role) VALUES ('workspace_alice', 'bob', 'member')`);
    const id = botOf(await reserve()).id;
    expect((await requestBotCancel(id, 'workspace_alice', 'bob'))?.cancelRequested).toBe(false); // a plain member: refused
    expect((await requestBotCancel(id, 'workspace_alice', 'alice'))?.cancelRequested).toBe(true);
    expect(await requestBotCancel(id, 'workspace_bob', 'bob')).toBeNull();                        // another workspace: nothing
    await advanceBotStatus(id, 'cancelled');
    expect((await requestBotCancel(id, 'workspace_alice', 'alice'))?.status).toBe('cancelled');
  });

  it('maps server states to the contract\'s names', () => {
    expect(toNotetakerStatus('requested')).toBe('scheduled');
    expect(toNotetakerStatus('call_ended')).toBe('processing');
    expect(toNotetakerStatus('recording')).toBe('recording');
  });
});

describe('Recall webhooks', () => {
  it('are stored once by webhook id; an unknown or malformed bot id is kept as unknown', async () => {
    const id = botOf(await reserve()).id;
    const ev = { webhookId: 'wh-1', meetingBotId: id, recallBotId: 'recall-1', event: 'bot.in_call_recording', payload: { a: 1 } };
    expect(await recordRecallEvent(ev)).toMatchObject({ inserted: true, processed: false });
    expect(await recordRecallEvent({ ...ev, webhookId: 'wh-2', meetingBotId: randomUUID() })).toMatchObject({ inserted: true });
    expect(await recordRecallEvent({ ...ev, webhookId: 'wh-3', meetingBotId: 'not-a-uuid' })).toMatchObject({ inserted: true });
    const { rows } = await pool.query(`SELECT webhook_id, meeting_bot_id FROM recall_events ORDER BY id`);
    expect(rows).toEqual([
      { webhook_id: 'wh-1', meeting_bot_id: id },
      { webhook_id: 'wh-2', meeting_bot_id: null },
      { webhook_id: 'wh-3', meeting_bot_id: null },
    ]);
  });

  it('a redelivery of an event never processed says so, so it is re-driven; a processed one does not', async () => {
    const ev = { webhookId: 'wh-9', meetingBotId: null, recallBotId: 'r', event: 'bot.done', payload: {} };
    const first = await recordRecallEvent(ev);
    expect(await recordRecallEvent(ev)).toEqual({ inserted: false, id: first.id, processed: false });
    expect((await listUnprocessedRecallEvents(-1000)).map((e) => e.id)).toEqual([first.id]);
    await markRecallEventProcessed(first.id!);
    expect(await recordRecallEvent(ev)).toEqual({ inserted: false, id: first.id, processed: true });
    expect(await listUnprocessedRecallEvents(-1000)).toEqual([]);
  });

  it('ingest waits for both the audio and the participant events', async () => {
    const id = botOf(await reserve()).id;
    expect(await markBotMediaReady(id, 'audio')).toMatchObject({ audioReady: true, participantsReady: false });
    expect(await markBotMediaReady(id, 'participants')).toMatchObject({ audioReady: true, participantsReady: true });
  });
});

describe('the notetaker\'s note', () => {
  it('is created recording and linked to its bot, with a mirror doc every client already lists; a replay changes nothing', async () => {
    const botId = botOf(await reserve()).id;
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: true });
    const { rows: [row] } = await pool.query(`SELECT status, source_type, source_kind, platform, author_uid FROM notes WHERE id = $1`, [noteIdForBot(botId)]);
    expect(row).toEqual({ status: 'recording', source_type: 'online_meeting', source_kind: 'bot', platform: 'google_meet', author_uid: 'alice' });
    expect((await getMeetingBotById(botId))?.noteId).toBe(noteIdForBot(botId));
    expect(docOf(botId)).toMatchObject({
      authorId: 'alice', workspaceId: 'workspace_alice', status: 'recording', type: 'online_meeting', sourceKind: 'bot',
      notetaker: { botId, status: 'scheduled', platform: 'google_meet', rank: 0 },
    });
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false });
    expect(await count(`SELECT 1 FROM notes WHERE id = $1`, [noteIdForBot(botId)])).toBe(1);
  });

  it('a retry restores a mirror doc an earlier attempt failed to write', async () => {
    const botId = botOf(await reserve()).id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    docs.clear(); // the first attempt's doc write "failed"
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false });
    expect(docOf(botId)).toMatchObject({ status: 'recording', authorId: 'alice' });
  });

  it('refuses another user\'s bot, and a bot from another workspace', async () => {
    const botId = botOf(await reserve()).id;
    await expect(createServerNote(fakeDb, noteInput(botId, { uid: 'bob', workspaceId: 'workspace_bob' }), quietLog))
      .rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  it('never comes back once deleted, even after the deletion tombstones are pruned', async () => {
    const botId = botOf(await reserve()).id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    expect(await deleteNote(fakeDb, { noteId: noteIdForBot(botId), workspaceId: 'workspace_alice', uid: 'alice' }, quietLog)).toMatchObject({ allowed: true, deleted: true });
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND note_deleted_at IS NOT NULL AND note_id IS NULL`, [botId])).toBe(1);
    // The sweep prunes the tombstones after 30 days.
    await pool.query(`DELETE FROM deleted_notes`);
    await pool.query(`DELETE FROM storage_purges`);
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false, deleted: true });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
    expect(docOf(botId)).toBeUndefined();
  });

  it('a bot whose account is gone creates nothing', async () => {
    const botId = randomUUID();
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false, deleted: true });
    expect(await count(`SELECT 1 FROM notes`)).toBe(0);
  });

  it('a note deleted between the commit and the doc write leaves no orphan doc', async () => {
    const botId = botOf(await reserve()).id;
    onCreate = async () => { await pool.query(`DELETE FROM notes WHERE id = $1`, [noteIdForBot(botId)]); };
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false, deleted: true });
    expect(docOf(botId)).toBeUndefined();
  });

  it('the mirrored status only moves forward, even when handlers finish out of order', async () => {
    const botId = botOf(await reserve()).id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    await advanceNotetaker(fakeDb, { botId, status: 'recording' }, quietLog);
    expect(docOf(botId).notetaker).toMatchObject({ status: 'recording', rank: 50 });
    // A slower handler that advanced to in_call earlier now mirrors: Postgres
    // ignores it, and the doc keeps the later status.
    await advanceNotetaker(fakeDb, { botId, status: 'in_call' }, quietLog);
    expect(docOf(botId).notetaker).toMatchObject({ status: 'recording', rank: 50 });
    // Simulate a stale mirror write racing a newer one directly.
    docs.set(`workspaces/workspace_alice/notes/${noteIdForBot(botId)}`, { ...docOf(botId), notetaker: { ...docOf(botId).notetaker, status: 'processing', rank: 70 } });
    await advanceNotetaker(fakeDb, { botId, status: 'recording' }, quietLog);
    expect(docOf(botId).notetaker).toMatchObject({ status: 'processing', rank: 70 });
    await advanceNotetaker(fakeDb, { botId, status: 'failed', failureReason: 'not_admitted' }, quietLog);
    expect(docOf(botId).notetaker).toMatchObject({ status: 'failed', failureReason: 'not_admitted', rank: 100 });
  });

  it('a missing doc for a live note throws (so the task retries); for a deleted note it is expected', async () => {
    const botId = botOf(await reserve()).id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    docs.clear();
    await expect(advanceNotetaker(fakeDb, { botId, status: 'joining' }, quietLog)).rejects.toThrow(/NOT_FOUND/);
  });

  it('speaker names seed the note in order of first speech; a rename wins, a replay never re-seeds, and bad segments are dropped', async () => {
    const botId = botOf(await reserve()).id;
    const noteId = noteIdForBot(botId);
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    const participants = [{ recallParticipantId: 'p-b', displayName: 'Ankush' }, { recallParticipantId: 'p-a', displayName: 'Sam' }, { recallParticipantId: 'p-c', displayName: 'Silent' }];
    const segments = [
      { startMs: 0, endMs: 5000, recallParticipantId: 'p-a' },
      { startMs: 5000, endMs: 9000, recallParticipantId: 'p-b' },
      { startMs: 9000, endMs: 12000, recallParticipantId: 'p-a' },
      { startMs: 13000, endMs: 12000.4, recallParticipantId: 'p-b' },          // end before start: clamped
      { startMs: Number.NaN, endMs: 14000, recallParticipantId: 'p-a' },       // not a time: dropped
    ];
    const saved = await saveMeetingSpeakers({ botId, noteId, participants, segments }, quietLog);
    expect(saved.gone).toBe(false);
    expect(Object.fromEntries((saved as { tags: Map<string, number> }).tags)).toEqual({ 'p-a': 1, 'p-b': 2 });
    expect(await getSpeakerSegments(noteId)).toEqual([
      { startMs: 0, endMs: 5000, speakerTag: 1 }, { startMs: 5000, endMs: 9000, speakerTag: 2 },
      { startMs: 9000, endMs: 12000, speakerTag: 1 }, { startMs: 13000, endMs: 13000, speakerTag: 2 },
    ]);
    const names = async () => (await pool.query(`SELECT speaker_tag, display_name FROM note_speakers WHERE note_id = $1 ORDER BY speaker_tag`, [noteId])).rows;
    expect(await names()).toEqual([{ speaker_tag: 1, display_name: 'Sam' }, { speaker_tag: 2, display_name: 'Ankush' }]);
    await pool.query(`UPDATE note_speakers SET display_name = 'Ankush K' WHERE note_id = $1 AND speaker_tag = 2`, [noteId]);
    await pool.query(`DELETE FROM note_speakers WHERE note_id = $1 AND speaker_tag = 1`, [noteId]);
    await markBotIngested(botId, 12);
    await saveMeetingSpeakers({ botId, noteId, participants, segments }, quietLog);
    expect(await names()).toEqual([{ speaker_tag: 2, display_name: 'Ankush K' }]);
  });

  it('saving speakers for a note deleted mid-meeting is "gone", not an error that retries to the dead letters', async () => {
    const botId = botOf(await reserve()).id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    await deleteNote(fakeDb, { noteId: noteIdForBot(botId), workspaceId: 'workspace_alice', uid: 'alice' }, quietLog);
    expect(await saveMeetingSpeakers({ botId, noteId: noteIdForBot(botId), participants: [], segments: [] }, quietLog)).toEqual({ gone: true });
  });
});

describe('Recall purges', () => {
  it('one row per Recall bot; a second request widens and re-arms it; confirmed marks the bot', async () => {
    const botId = botOf(await reserve()).id;
    await attachRecallBot(botId, 'recall-9');
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'ingested' });
    const [p] = await listPendingRecallPurges();
    for (let i = 0; i < 3; i++) await recordRecallPurgeAttempt(p!.id, 'recall 503');
    expect(await listPendingRecallPurges(50, 3)).toEqual([]);
    expect((await listExhaustedRecallPurges(3)).map((x) => x.recallBotId)).toEqual(['recall-9']);
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'note_deleted', leaveCall: true });
    expect((await listPendingRecallPurges(50, 3))[0]).toMatchObject({ recallBotId: 'recall-9', leaveCall: true, attempts: 0 });
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'failed', leaveCall: false });
    expect((await listPendingRecallPurges())[0]?.leaveCall).toBe(true); // never un-asked
    await confirmRecallPurge('recall-9');
    expect(await listPendingRecallPurges()).toEqual([]);
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND recall_media_deleted_at IS NOT NULL`, [botId])).toBe(1);
  });

  it('the URL hash ignores the scheme, case and non-identifying query, but keeps a query that names the meeting', () => {
    expect(meetingUrlHash('https://zoom.us/j/123?pwd=abc')).toBe(meetingUrlHash('http://ZOOM.us/j/123/'));
    expect(meetingUrlHash('https://zoom.us/j/123')).not.toBe(meetingUrlHash('https://zoom.us/j/124'));
    expect(meetingUrlHash('https://acme.webex.com/acme/j.php?MTID=m1')).not.toBe(meetingUrlHash('https://acme.webex.com/acme/j.php?MTID=m2'));
  });
});
