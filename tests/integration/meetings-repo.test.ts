import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getPool,
  reserveMeetingBot, advanceBotStatus, attachRecallBot, requestBotCancel, recordRecallEvent,
  markBotMediaReady, saveMeetingSpeakers, markBotIngested, linkBotNote, getMeetingBot,
  enqueueRecallPurge, listPendingRecallPurges, recordRecallPurgeAttempt, confirmRecallPurge,
  createServerNote, noteIdForBot, meetingUrlHash, toNotetakerStatus, getSpeakerSegments,
  WorkspaceBoundaryError,
} from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, count, quietLog } from './helpers';

// The notetaker's data layer (migration 023, meetings-repo.ts, createServerNote)
// against real Postgres. The rules under test: one bot gives one note in one
// workspace; replays and out-of-order webhooks change nothing; minutes are
// reserved under a lock.
const docs = new Map<string, Record<string, unknown>>();
let onSet: ((path: string) => Promise<void>) | null = null;
function docRef(path: string) {
  return {
    path,
    async get() { const d = docs.get(path); return { exists: d !== undefined, data: () => d }; },
    async set(v: Record<string, unknown>) { docs.set(path, v); if (onSet) await onSet(path); },
    async update(v: Record<string, unknown>) {
      if (!docs.has(path)) throw Object.assign(new Error(`5 NOT_FOUND: ${path}`), { code: 5 });
      docs.set(path, { ...docs.get(path), ...v });
    },
    async delete() { docs.delete(path); },
  };
}
const fakeDb = { doc: docRef } as never;

const MEET = 'https://meet.google.com/abc-defg-hij';
const periodStart = new Date(Date.now() - 24 * 3600 * 1000);
const reserve = (over: Partial<Parameters<typeof reserveMeetingBot>[0]> = {}) => reserveMeetingBot({
  botId: randomUUID(), uid: 'alice', workspaceId: 'workspace_alice', requestId: randomUUID(),
  platform: 'google_meet', meetingUrl: MEET, allowanceMinutes: 600, periodStart,
  maxMeetingMinutes: 240, maxActiveGlobal: 100, noticeVersion: 'notice-v1', traceId: 't1', ...over,
}, quietLog);

beforeEach(async () => {
  await resetDb();
  docs.clear();
  onSet = null;
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
    if (first.kind !== 'reserved') return;
    expect(first.bot).toMatchObject({ status: 'requested', reservedMinutes: 240, uid: 'alice', workspaceId: 'workspace_alice' });
    expect(await count(`SELECT 1 FROM meeting_consents WHERE meeting_bot_id = $1 AND notice_version = 'notice-v1'`, [first.bot.id])).toBe(1);
    const again = await reserve({ requestId });
    expect(again).toMatchObject({ kind: 'existing', bot: { id: first.bot.id } });
    expect(await count('SELECT 1 FROM meeting_bots')).toBe(1);
  });

  it('refuses a second live bot on the same meeting in the same workspace (query and slash ignored)', async () => {
    const a = await reserve();
    const b = await reserve({ meetingUrl: `${MEET}/?authuser=1` });
    expect(b).toMatchObject({ kind: 'duplicate_active', bot: { id: (a as any).bot.id } });
  });

  it('another workspace in the same meeting gets its own bot (never a share of this one)', async () => {
    const a = await reserve();
    const b = await reserve({ uid: 'bob', workspaceId: 'workspace_bob' });
    expect(a.kind).toBe('reserved');
    expect(b.kind).toBe('reserved');
    expect((a as any).bot.id).not.toBe((b as any).bot.id);
    // Each workspace sees only its own.
    expect(await getMeetingBot((a as any).bot.id, 'workspace_bob')).toBeNull();
  });

  it('caps live bots per user and globally', async () => {
    await reserve({ meetingUrl: 'https://meet.google.com/aaa-aaaa-aaa' });
    await reserve({ meetingUrl: 'https://meet.google.com/bbb-bbbb-bbb' });
    expect((await reserve({ meetingUrl: 'https://meet.google.com/ccc-cccc-ccc' })).kind).toBe('too_many');
    expect((await reserve({ uid: 'bob', workspaceId: 'workspace_bob', maxActiveGlobal: 2 })).kind).toBe('busy');
  });

  it('holds minutes until the bot ends, releases them on failure, and counts a recording by its length', async () => {
    const a = await reserve({ allowanceMinutes: 300, maxMeetingMinutes: 240 });
    expect((a as any).bot.reservedMinutes).toBe(240);
    // 60 minutes left: under the 240 cap, above the 15 minimum.
    const b = await reserve({ allowanceMinutes: 300, meetingUrl: 'https://meet.google.com/bbb-bbbb-bbb' });
    expect((b as any).bot.reservedMinutes).toBe(60);
    await advanceBotStatus((b as any).bot.id, 'failed', { failureReason: 'not_admitted' });
    await markBotIngested((a as any).bot.id, 30 * 60);
    await advanceBotStatus((a as any).bot.id, 'done');
    // Settled 30 + released 0: 270 left.
    const c = await reserve({ allowanceMinutes: 300, meetingUrl: 'https://meet.google.com/ccc-cccc-ccc' });
    expect((c as any).bot.reservedMinutes).toBe(240);
    const d = await reserve({ allowanceMinutes: 280, meetingUrl: 'https://meet.google.com/ddd-dddd-ddd' });
    expect(d).toEqual({ kind: 'quota_exhausted', remainingMinutes: 10 });
  });

  it('two requests at once for the same meeting: one bot, not two (the workspace lock)', async () => {
    const [x, y] = await Promise.all([reserve(), reserve()]);
    expect([x.kind, y.kind].sort()).toEqual(['duplicate_active', 'reserved']);
    expect(await count('SELECT 1 FROM meeting_bots')).toBe(1);
  });
});

describe('a bot\'s status', () => {
  it('only moves forward, a terminal status is final, and the meeting link is forgotten once in the call', async () => {
    const r = await reserve({ meetingUrlCiphertext: Buffer.from('secret') });
    const id = (r as any).bot.id;
    await attachRecallBot(id, 'recall-1');
    expect((await advanceBotStatus(id, 'recording')).changed).toBe(true);
    expect((await advanceBotStatus(id, 'joining')).changed).toBe(false); // late webhook
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND meeting_url_ciphertext IS NULL`, [id])).toBe(1);
    expect((await advanceBotStatus(id, 'done')).changed).toBe(true);
    expect((await advanceBotStatus(id, 'failed', { failureReason: 'error' })).changed).toBe(false);
    expect((await getMeetingBot(id, 'workspace_alice'))?.status).toBe('done');
  });

  it('a cancel is recorded on a live bot, and ignored on a finished one', async () => {
    const r = await reserve();
    const id = (r as any).bot.id;
    expect((await requestBotCancel(id, 'workspace_alice'))?.cancelRequested).toBe(true);
    expect(await requestBotCancel(id, 'workspace_bob')).toBeNull(); // another workspace: nothing
    await advanceBotStatus(id, 'cancelled');
    expect((await requestBotCancel(id, 'workspace_alice'))?.status).toBe('cancelled');
  });

  it('maps server states to the contract\'s names', () => {
    expect(toNotetakerStatus('requested')).toBe('scheduled');
    expect(toNotetakerStatus('call_ended')).toBe('processing');
    expect(toNotetakerStatus('recording')).toBe('recording');
  });
});

describe('Recall webhooks', () => {
  it('are stored once by webhook id; an unknown or malformed bot id is kept as unknown', async () => {
    const r = await reserve();
    const id = (r as any).bot.id;
    const ev = { webhookId: 'wh-1', meetingBotId: id, recallBotId: 'recall-1', event: 'bot.in_call_recording', payload: { a: 1 } };
    expect((await recordRecallEvent(ev)).inserted).toBe(true);
    expect((await recordRecallEvent(ev)).inserted).toBe(false);
    expect((await recordRecallEvent({ ...ev, webhookId: 'wh-2', meetingBotId: randomUUID() })).inserted).toBe(true);
    expect((await recordRecallEvent({ ...ev, webhookId: 'wh-3', meetingBotId: 'not-a-uuid' })).inserted).toBe(true);
    const { rows } = await pool.query(`SELECT webhook_id, meeting_bot_id FROM recall_events ORDER BY id`);
    expect(rows).toEqual([
      { webhook_id: 'wh-1', meeting_bot_id: id },
      { webhook_id: 'wh-2', meeting_bot_id: null },
      { webhook_id: 'wh-3', meeting_bot_id: null },
    ]);
  });

  it('ingest waits for both the audio and the participant events', async () => {
    const id = ((await reserve()) as any).bot.id;
    expect(await markBotMediaReady(id, 'audio')).toMatchObject({ audioReady: true, participantsReady: false });
    expect(await markBotMediaReady(id, 'participants')).toMatchObject({ audioReady: true, participantsReady: true });
  });
});

describe('the notetaker\'s note', () => {
  const noteInput = (botId: string, over: Record<string, unknown> = {}) => ({
    noteId: noteIdForBot(botId), workspaceId: 'workspace_alice', uid: 'alice', title: 'Weekly sync',
    sourceType: 'online_meeting' as const, sourceKind: 'bot' as const, platform: 'google_meet',
    notetaker: { botId, status: 'scheduled', platform: 'google_meet' }, ...over,
  });

  it('is created recording, with a mirror doc every client already lists, and a replay changes nothing', async () => {
    const botId = randomUUID();
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: true });
    const { rows: [row] } = await pool.query(`SELECT status, source_type, source_kind, platform, author_uid FROM notes WHERE id = $1`, [noteIdForBot(botId)]);
    expect(row).toEqual({ status: 'recording', source_type: 'online_meeting', source_kind: 'bot', platform: 'google_meet', author_uid: 'alice' });
    expect(docs.get(`workspaces/workspace_alice/notes/${noteIdForBot(botId)}`)).toMatchObject({
      authorId: 'alice', workspaceId: 'workspace_alice', status: 'recording', type: 'online_meeting', sourceKind: 'bot',
      notetaker: { botId, status: 'scheduled', platform: 'google_meet' },
    });
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false });
    expect(await count(`SELECT 1 FROM notes WHERE id = $1`, [noteIdForBot(botId)])).toBe(1);
  });

  it('refuses an id another workspace owns, and never brings a deleted note back', async () => {
    const botId = randomUUID();
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    await expect(createServerNote(fakeDb, noteInput(botId, { workspaceId: 'workspace_bob', uid: 'bob' }), quietLog))
      .rejects.toBeInstanceOf(WorkspaceBoundaryError);
    const gone = randomUUID();
    await pool.query(`INSERT INTO deleted_notes (note_id, workspace_id) VALUES ($1, 'workspace_alice')`, [noteIdForBot(gone)]);
    expect(await createServerNote(fakeDb, noteInput(gone), quietLog)).toEqual({ created: false, deleted: true });
    expect(docs.has(`workspaces/workspace_alice/notes/${noteIdForBot(gone)}`)).toBe(false);
  });

  it('a note deleted between the commit and the doc write leaves no orphan doc', async () => {
    const botId = randomUUID();
    onSet = async () => { await pool.query(`DELETE FROM notes WHERE id = $1`, [noteIdForBot(botId)]); };
    expect(await createServerNote(fakeDb, noteInput(botId), quietLog)).toEqual({ created: false, deleted: true });
    expect(docs.has(`workspaces/workspace_alice/notes/${noteIdForBot(botId)}`)).toBe(false);
  });

  it('speaker names seed the note in order of first speech; a rename wins, and a replay never re-seeds', async () => {
    const r = await reserve();
    const botId = (r as any).bot.id;
    const noteId = noteIdForBot(botId);
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    await linkBotNote(botId, noteId);
    const participants = [{ recallParticipantId: 'p-b', displayName: 'Ankush' }, { recallParticipantId: 'p-a', displayName: 'Sam' }, { recallParticipantId: 'p-c', displayName: 'Silent' }];
    const segments = [{ startMs: 0, endMs: 5000, recallParticipantId: 'p-a' }, { startMs: 5000, endMs: 9000, recallParticipantId: 'p-b' }, { startMs: 9000, endMs: 12000, recallParticipantId: 'p-a' }];
    const tags = await saveMeetingSpeakers({ botId, noteId, participants, segments }, quietLog);
    expect(Object.fromEntries(tags)).toEqual({ 'p-a': 1, 'p-b': 2 });
    expect(await getSpeakerSegments(noteId)).toEqual([
      { startMs: 0, endMs: 5000, speakerTag: 1 }, { startMs: 5000, endMs: 9000, speakerTag: 2 }, { startMs: 9000, endMs: 12000, speakerTag: 1 },
    ]);
    const names = async () => (await pool.query(`SELECT speaker_tag, display_name FROM note_speakers WHERE note_id = $1 ORDER BY speaker_tag`, [noteId])).rows;
    expect(await names()).toEqual([{ speaker_tag: 1, display_name: 'Sam' }, { speaker_tag: 2, display_name: 'Ankush' }]);
    // The user renames speaker 2 and clears speaker 1; then ingest replays.
    await pool.query(`UPDATE note_speakers SET display_name = 'Ankush K' WHERE note_id = $1 AND speaker_tag = 2`, [noteId]);
    await pool.query(`DELETE FROM note_speakers WHERE note_id = $1 AND speaker_tag = 1`, [noteId]);
    await markBotIngested(botId, 12);
    await saveMeetingSpeakers({ botId, noteId, participants, segments }, quietLog);
    expect(await names()).toEqual([{ speaker_tag: 2, display_name: 'Ankush K' }]);
  });

  it('deleting the note leaves the bot row (its purge still has to run), pointing nowhere', async () => {
    const r = await reserve();
    const botId = (r as any).bot.id;
    await createServerNote(fakeDb, noteInput(botId), quietLog);
    await linkBotNote(botId, noteIdForBot(botId));
    await pool.query(`DELETE FROM notes WHERE id = $1`, [noteIdForBot(botId)]);
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND note_id IS NULL`, [botId])).toBe(1);
  });
});

describe('Recall purges', () => {
  it('one row per Recall bot; a second reason only widens it; confirmed marks the bot', async () => {
    const r = await reserve();
    const botId = (r as any).bot.id;
    await attachRecallBot(botId, 'recall-9');
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'ingested' });
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'note_deleted', leaveCall: true });
    await enqueueRecallPurge(null, { recallBotId: 'recall-9', reason: 'failed', leaveCall: false });
    const [p] = await listPendingRecallPurges();
    expect(p).toMatchObject({ recallBotId: 'recall-9', reason: 'ingested', leaveCall: true, attempts: 0 });
    await recordRecallPurgeAttempt(p!.id, 'recall 503');
    expect((await listPendingRecallPurges())[0]?.attempts).toBe(1);
    expect(await listPendingRecallPurges(50, 1)).toEqual([]);
    await confirmRecallPurge('recall-9');
    expect(await count(`SELECT 1 FROM recall_purges WHERE confirmed_at IS NOT NULL`)).toBe(1);
    expect(await count(`SELECT 1 FROM meeting_bots WHERE id = $1 AND recall_media_deleted_at IS NOT NULL`, [botId])).toBe(1);
  });

  it('the URL hash ignores the query and case, so a pwd= never matters to de-duplication', () => {
    expect(meetingUrlHash('https://zoom.us/j/123?pwd=abc')).toBe(meetingUrlHash('https://ZOOM.us/j/123/'));
    expect(meetingUrlHash('https://zoom.us/j/123')).not.toBe(meetingUrlHash('https://zoom.us/j/124'));
  });
});
