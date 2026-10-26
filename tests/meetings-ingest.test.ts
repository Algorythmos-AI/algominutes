import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM modules, no type declarations
import { createIngestTasks, pickRecording, recordingSeconds, toParticipants, toSegments, nothingLeftAtRecall, MAX_RECORDING_BYTES } from '../services/meetings/src/tasks/ingest.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { allowedMediaUrl, mediaHosts, openMedia, readJsonMedia, byteCap, MediaError, DEFAULT_MEDIA_HOSTS } from '../services/meetings/src/lib/media-download.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { RecallError, createRecallClient } from '../services/meetings/src/lib/recall-client.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { createRecordingsStore } from '../services/meetings/src/lib/recordings-store.js';
import { Readable, Writable } from 'node:stream';
import { noteIdForBot } from '@algominutes/db';
import { pipeline } from 'node:stream/promises';

// The notetaker's ingest (RELEASE.md PR 19): a recording Recall made, made ours. Against fakes of Recall, its
// media hosts, the recordings bucket, the repo and the kickoff: what is fetched and from where, what is stored,
// what is queued, and that Recall's copy is always asked to go. Replays change nothing.

const AUDIO_URL = 'https://ap-northeast-1-media.s3.ap-northeast-1.amazonaws.com/audio.mp3?X-Amz-Signature=sekrit-audio';
const PARTICIPANTS_URL = 'https://media.recall.ai/participants.json?token=sekrit-p';
const TIMELINE_URL = 'https://media.recall.ai/timeline.json?token=sekrit-t';
const ENV = { RECALL_REGION: 'ap-northeast-1' };

const recording = (over: any = {}) => ({
  id: 'rec-1',
  started_at: '2026-09-28T01:00:00Z',
  completed_at: '2026-09-28T01:30:05Z',
  status: { code: 'done' },
  media_shortcuts: {
    audio_mixed: { status: { code: 'done' }, data: { download_url: AUDIO_URL } },
    participant_events: {
      status: { code: 'done' },
      data: { participants_download_url: PARTICIPANTS_URL, speaker_timeline_download_url: TIMELINE_URL },
    },
  },
  ...over,
});

const PARTICIPANTS = [
  { id: 100, name: ' Alice ', is_host: true, platform: 'desktop', email: 'alice@example.com' },
  { id: 200, name: 'Bob', is_host: false, platform: 'desktop', email: null },
  { id: 300, name: 'Silent Sam', is_host: false },
];
const TIMELINE = [
  { participant: { id: 200, name: 'Bob' }, start_timestamp: { relative: 1.5 }, end_timestamp: { relative: 4 } },
  { participant: { id: 100, name: 'Alice' }, start_timestamp: { relative: 4.25 }, end_timestamp: null },
  { participant: { id: 200, name: 'Bob' }, start_timestamp: { relative: 9 }, end_timestamp: { relative: 12.5 } },
];

const body = (text: string | Buffer) => Readable.toWeb(Readable.from([Buffer.from(text)])) as any;
const response = (status: number, text: string | Buffer = '', headers: Record<string, string> = {}) =>
  ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: body(text) });

function world(over: Partial<{ ingestedAt: string | null; billableSeconds: number | null; noteId: string | null; runQueuedAt: string | null }> = {}) {
  const bot: any = {
    id: '7f0e0c1a-0000-4000-8000-000000000001', uid: 'alice', workspaceId: 'workspace_alice',
    noteId: over.noteId === undefined ? 'mtg_7f0e' : over.noteId, recallBotId: 'recall-1',
    status: 'call_ended', reservedMinutes: 90, traceId: 'trace-1',
    ingestedAt: over.ingestedAt ?? null, billableSeconds: over.billableSeconds ?? null, runQueuedAt: over.runQueuedAt ?? null,
  };
  const calls: string[] = [];
  const recall: any = {
    remote: { id: 'recall-1', recordings: [recording()], status_changes: [{ code: 'done' }] },
    getBot: async (id: string) => { calls.push(`recall:get:${id}`); if (recall.getFails) throw recall.getFails; return recall.remote; },
    deleteMedia: async (id: string) => { calls.push(`recall:delete_media:${id}`); if (recall.deleteFails) throw recall.deleteFails; return null; },
    leaveCall: async (id: string) => { calls.push(`recall:leave:${id}`); if (recall.leaveFails) throw recall.leaveFails; return null; },
  };
  const served: Record<string, () => any> = {
    [AUDIO_URL]: () => response(200, Buffer.alloc(4096, 7), { 'content-length': '4096' }),
    [PARTICIPANTS_URL]: () => response(200, JSON.stringify(PARTICIPANTS)),
    [TIMELINE_URL]: () => response(200, JSON.stringify(TIMELINE)),
  };
  const fetchImpl = async (url: string, init: any) => {
    calls.push(`fetch:${new URL(url).hostname}`);
    expect(init.redirect).toBe('manual');
    const r = served[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r();
  };
  const objects = new Map<string, number>();
  const store: any = {
    write: async (path: string, web: any, { contentType, maxBytes }: { contentType: string; maxBytes: number }) => {
      calls.push(`store:write:${path}:${contentType}`);
      expect(maxBytes).toBe(MAX_RECORDING_BYTES);
      const cap = byteCap(maxBytes);
      await pipeline(Readable.fromWeb(web), cap, async function* (src: AsyncIterable<Buffer>) { for await (const _ of src) { /* drained */ } });
      objects.set(path, cap.bytes());
      return cap.bytes();
    },
    size: async (path: string) => objects.get(path) ?? null,
    removeNote: async ({ workspaceId, noteId }: { workspaceId: string; noteId: string }) => {
      calls.push(`store:remove:${workspaceId}/${noteId}`);
      objects.delete(`recordings/${workspaceId}/${noteId}.mp3`);
    },
  };
  const saved: any[] = [];
  const repo: any = {
    getMeetingBotById: async (id: string) => (id === bot.id ? { ...bot } : null),
    saveMeetingSpeakers: async (input: any) => {
      calls.push('repo:speakers'); saved.push(input);
      return repo.noteGone ? { gone: true } : { gone: false, tags: new Map() };
    },
    markBotIngested: async (_id: string, seconds: number) => { calls.push(`repo:ingested:${seconds}`); bot.ingestedAt = '2026-09-28T01:31:00Z'; bot.billableSeconds = seconds; },
    enqueueRecallPurge: async (_c: unknown, input: any) => {
      calls.push(`repo:purge:${input.recallBotId}:${input.reason}`); expect(input.traceId).toBe('trace-1');
      if (repo.purgeFailsOnce) { const e = repo.purgeFailsOnce; repo.purgeFailsOnce = null; throw e; }
    },
    advanceNotetaker: async (_fs: unknown, input: any) => { calls.push(`repo:bot:${input.status}`); return { changed: true, bot }; },
    failNotetaker: async (_fs: unknown, input: any) => { calls.push(`repo:bot:${input.status}:${input.failureReason}`); return { changed: true, bot: { ...bot, status: input.status } }; },
    recordDeadLetter: async (d: any) => { calls.push(`repo:dead_letter:${d.payload.kind}`); return { id: 1 }; },
    withRecallPurgeLock: async (fn: () => Promise<unknown>) => (repo.lockHeld ? { ran: false } : { ran: true, value: await fn() }),
    listPendingRecallPurges: async () => repo.pending ?? [],
    listExhaustedRecallPurges: async () => repo.exhausted ?? [],
    recordRecallPurgeAttempt: async (id: number, err: string | null) => { calls.push(`repo:attempt:${id}:${err ?? 'ok'}`); },
    confirmRecallPurge: async (id: string) => { calls.push(`repo:confirmed:${id}`); },
  };
  const kickoffs: any[] = [];
  const queueNoteRun = async (input: any) => {
    kickoffs.push({ ...input, size: await input.probeSize() });
    calls.push(`kickoff:${input.noteId}`);
    if (queueNoteRun.result.kind === 'queued') bot.runQueuedAt = '2026-09-28T01:32:00Z';
    return queueNoteRun.result;
  };
  queueNoteRun.result = { kind: 'queued', jobId: 'job-1' } as any;
  let recallAsked = 0;
  const tasks = createIngestTasks({
    getRecall: async () => { recallAsked += 1; return recall; },
    getFirestore: () => ({ fs: true }),
    env: ENV, repo, queueNoteRun, store, fetchImpl,
  });
  const lines: any[] = [];
  const logger = (bound: object): any => ({
    info: (o: object, msg: string) => lines.push({ level: 'info', msg, ...bound, ...o }),
    warn: (o: object, msg: string) => lines.push({ level: 'warn', msg, ...bound, ...o }),
    error: (o: object, msg: string) => lines.push({ level: 'error', msg, ...bound, ...o }),
    child: (b: object) => logger({ ...bound, ...b }),
  });
  let lastBody: any = null;
  const run = async (kind: string, reqBody: object = { meetingBotId: bot.id }, headers: Record<string, string> = {}) => {
    let status = 0;
    const res: any = { status: (s: number) => ((status = s), res), json: (b: any) => ((lastBody = b), res) };
    await tasks[kind]({ body: reqBody, headers, log: logger({ traceId: 'dispatch-trace' }) }, res);
    return status;
  };
  return { bot, calls, recall, repo, store, objects, saved, kickoffs, queueNoteRun, run, lines, served, recallAsked: () => recallAsked, lastBody: () => lastBody };
}

describe('Recall\'s files, read as ours', () => {
  it('picks the last recording whose audio and participant events are both done, and counts them', () => {
    const late = recording({ id: 'rec-2' });
    const unfinished = recording({ id: 'rec-3', media_shortcuts: { ...recording().media_shortcuts, participant_events: { status: { code: 'processing' }, data: {} } } });
    expect(pickRecording({ recordings: [recording(), late, unfinished] })).toEqual({ recording: late, count: 2 });
    expect(pickRecording({ recordings: [unfinished] })).toEqual({ recording: null, count: 0 });
    const noUrl = recording({ media_shortcuts: { ...recording().media_shortcuts, audio_mixed: { status: { code: 'done' }, data: {} } } });
    expect(pickRecording({ recordings: [noUrl] }).recording).toBeNull();
    expect(pickRecording(null)).toEqual({ recording: null, count: 0 });
  });

  it('a recording\'s length comes from Recall\'s start and end, or is unknown', () => {
    expect(recordingSeconds(recording())).toBe(1805);
    expect(recordingSeconds({ started_at: '2026-09-28T01:00:00Z' })).toBeNull();
    expect(recordingSeconds({ started_at: '2026-09-28T01:00:00Z', completed_at: '2026-09-28T00:59:00Z' })).toBeNull();
    expect(recordingSeconds({ started_at: 'soon', completed_at: 'later' })).toBeNull();
  });

  it('participants keep Recall\'s id (as text) and a trimmed name; a row without an id is dropped', () => {
    expect(toParticipants([...PARTICIPANTS, { name: 'no id' }, null])).toEqual([
      { recallParticipantId: '100', displayName: 'Alice' },
      { recallParticipantId: '200', displayName: 'Bob' },
      { recallParticipantId: '300', displayName: 'Silent Sam' },
    ]);
    expect(toParticipants({ not: 'a list' })).toEqual([]);
  });

  it('the timeline is in ms; a speaker without an end speaks until the next starts, and the last until its start', () => {
    expect(toSegments([...TIMELINE, { participant: { id: 100 }, start_timestamp: { relative: 20 } }, { start_timestamp: { relative: 30 } }])).toEqual([
      { recallParticipantId: '200', startMs: 1500, endMs: 4000 },
      { recallParticipantId: '100', startMs: 4250, endMs: 9000 },
      { recallParticipantId: '200', startMs: 9000, endMs: 12500 },
      { recallParticipantId: '100', startMs: 20000, endMs: 20000 },
    ]);
    expect(toSegments('nope')).toEqual([]);
  });

  it('Recall holds nothing once the bot has ended and every recording it made is deleted (or it made none)', () => {
    expect(nothingLeftAtRecall({ status_changes: [{ code: 'in_call_recording' }, { code: 'done' }], recordings: [{ status: { code: 'deleted' } }] })).toBe(true);
    expect(nothingLeftAtRecall({ status_changes: [{ code: 'fatal' }], recordings: [] })).toBe(true);
    expect(nothingLeftAtRecall({ status_changes: [{ code: 'media_expired' }], recordings: [{ status: { code: 'done' } }] })).toBe(false);
    expect(nothingLeftAtRecall({ status_changes: [{ code: 'done' }], recordings: [{ status: { code: 'done' } }] })).toBe(false);
    expect(nothingLeftAtRecall({ status_changes: [{ code: 'in_waiting_room' }], recordings: [] })).toBe(false);
    expect(nothingLeftAtRecall({})).toBe(false);
  });
});

describe('downloading from Recall (SSRF)', () => {
  const hosts = mediaHosts(ENV);

  it('allows HTTPS on 443 to Recall and S3 only: never another amazonaws.com host, a port, user info, or plain HTTP', () => {
    expect(hosts).toEqual([...DEFAULT_MEDIA_HOSTS, '.s3.ap-northeast-1.amazonaws.com']);
    expect(allowedMediaUrl(AUDIO_URL, hosts)).not.toBeNull();
    expect(allowedMediaUrl('https://bucket.s3.amazonaws.com/a.mp3', hosts)).not.toBeNull();
    expect(allowedMediaUrl('https://media.recall.ai:443/a', hosts)).not.toBeNull();
    for (const bad of [
      'http://media.recall.ai/a',
      'https://media.recall.ai:8443/a',
      'https://user:pw@media.recall.ai/a',
      'https://recall.ai.evil.example/a',
      'https://evilrecall.ai/a',
      'https://ec2-169-254-169-254.compute-1.amazonaws.com/latest/meta-data',
      'https://s3.amazonaws.com.evil.example/a',
      'https://169.254.169.254/latest',
      'file:///etc/passwd',
      'not a url',
    ]) expect(allowedMediaUrl(bad, hosts), bad).toBeNull();
  });

  it('RECALL_MEDIA_HOSTS replaces the list; a region that isn\'t one adds nothing', () => {
    expect(mediaHosts({ RECALL_MEDIA_HOSTS: ' Media.Recall.ai , .s3.amazonaws.com' })).toEqual(['media.recall.ai', '.s3.amazonaws.com']);
    expect(allowedMediaUrl('https://other.recall.ai/a', mediaHosts({ RECALL_MEDIA_HOSTS: 'media.recall.ai' }))).toBeNull();
    expect(mediaHosts({ RECALL_REGION: 'x.evil.example' })).toEqual(DEFAULT_MEDIA_HOSTS);
  });

  it('follows a redirect on the same host only, and refuses one elsewhere, too many, or a refused status', async () => {
    const seen: string[] = [];
    const hop = (to: string) => response(302, '', { location: to });
    const fetchFrom = (map: Record<string, any>) => async (url: string) => { seen.push(url); return map[url]; };
    const ok = await openMedia('https://media.recall.ai/a', {
      hosts, maxBytes: 100, fetchImpl: fetchFrom({ 'https://media.recall.ai/a': hop('/b'), 'https://media.recall.ai/b': response(200, 'hi') }),
    });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['https://media.recall.ai/a', 'https://media.recall.ai/b']);
    await expect(openMedia('https://media.recall.ai/a', {
      hosts, maxBytes: 100, fetchImpl: fetchFrom({ 'https://media.recall.ai/a': hop('https://other.recall.ai/b') }),
    })).rejects.toThrow('media redirect to another host refused');
    await expect(openMedia('https://media.recall.ai/a', {
      hosts, maxBytes: 100, fetchImpl: fetchFrom({ 'https://media.recall.ai/a': hop('http://media.recall.ai/b') }),
    })).rejects.toThrow('media redirect to another host refused');
    await expect(openMedia('https://media.recall.ai/a', {
      hosts, maxBytes: 100, maxRedirects: 2, fetchImpl: async () => hop('/a'),
    })).rejects.toThrow('media redirected too many times');
    await expect(openMedia('https://media.recall.ai/a', { hosts, maxBytes: 100, fetchImpl: async () => response(403) }))
      .rejects.toMatchObject({ name: 'MediaError', status: 403 });
    await expect(openMedia('https://evil.example/a', { hosts, maxBytes: 100, fetchImpl: async () => { throw new Error('fetched'); } }))
      .rejects.toThrow('media URL not allowed');
  });

  it('refuses media past the cap, whether it says so up front or not', async () => {
    await expect(openMedia('https://media.recall.ai/a', { hosts, maxBytes: 10, fetchImpl: async () => response(200, 'x'.repeat(20), { 'content-length': '20' }) }))
      .rejects.toThrow('media larger than allowed');
    await expect(readJsonMedia('https://media.recall.ai/a', { hosts, maxBytes: 10, fetchImpl: async () => response(200, JSON.stringify('x'.repeat(20))) }))
      .rejects.toThrow('media larger than allowed');
    const cap = byteCap(4);
    await expect(pipeline(Readable.from([Buffer.from('12345')]), cap, async function* (s: AsyncIterable<Buffer>) { for await (const _ of s) { /* drained */ } }))
      .rejects.toBeInstanceOf(MediaError);
  });

  it('a file that isn\'t JSON fails without quoting it (it holds people\'s names)', async () => {
    const err = await readJsonMedia('https://media.recall.ai/a', { hosts, maxBytes: 1000, fetchImpl: async () => response(200, '[{"name":"Alice Example"') })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(err.message).toBe('media is not JSON');
    expect(JSON.stringify(err)).not.toContain('Alice');
  });
});

describe('ingest', () => {
  it('stores the audio at the note\'s object, the speakers, the minutes, queues the run, and asks Recall to delete its copy', async () => {
    const w = world();
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls).toEqual([
      'recall:get:recall-1',
      'fetch:media.recall.ai',
      'fetch:media.recall.ai',
      'fetch:ap-northeast-1-media.s3.ap-northeast-1.amazonaws.com',
      'store:write:recordings/workspace_alice/mtg_7f0e.mp3:audio/mpeg',
      'repo:speakers',
      'repo:ingested:1805',
      'kickoff:mtg_7f0e',
      'repo:purge:recall-1:ingested',
      'recall:delete_media:recall-1',
      'repo:bot:done',
    ]);
    expect(w.saved[0]).toEqual({
      botId: w.bot.id, noteId: 'mtg_7f0e',
      participants: toParticipants(PARTICIPANTS),
      segments: toSegments(TIMELINE),
    });
    expect(w.kickoffs[0]).toMatchObject({
      firestore: { fs: true }, noteId: 'mtg_7f0e', workspaceId: 'workspace_alice', uid: 'alice',
      type: 'online_meeting', storagePath: 'recordings/workspace_alice/mtg_7f0e.mp3', mimeType: 'audio/mpeg',
      durationSec: 1805, size: 4096, quota: false, usageBudget: false, allowRecording: true, traceId: 'trace-1',
      meetingBotId: w.bot.id,
    });
    // One trace, and the bot's ids, on every line; no presigned URL anywhere.
    expect(w.lines.length).toBeGreaterThan(0);
    for (const l of w.lines) expect(l).toMatchObject({ traceId: 'trace-1', taskTraceId: expect.any(String), userId: 'alice', workspaceId: 'workspace_alice', noteId: 'mtg_7f0e' });
    expect(JSON.stringify(w.lines)).not.toMatch(/sekrit|X-Amz|download_url/);
    expect(w.lines.map((l) => l.msg)).toEqual(['notetaker_recording_ingested', 'recall_media_delete_requested', 'notetaker_ingest_done']);
  });

  it('a replay after it was ingested fetches nothing from Recall, re-reads the size and the settled seconds, and finds the run going', async () => {
    const w = world();
    await w.run('ingest');
    w.calls.length = 0;
    w.queueNoteRun.result = { kind: 'in_flight', status: 'transcribing' };
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls).toEqual(['kickoff:mtg_7f0e', 'repo:purge:recall-1:ingested', 'recall:delete_media:recall-1', 'repo:bot:done']);
    expect(w.kickoffs[1]).toMatchObject({ durationSec: 1805, meetingBotId: w.bot.id });
  });

  it('a crash after the bot was marked ingested but before the kickoff still meters the run on the replay', async () => {
    const w = world();
    w.queueNoteRun.result = { kind: 'failed', message: 'try again' };
    await expect(w.run('ingest')).rejects.toThrow('notetaker_kickoff_failed');
    expect(w.calls).not.toContain('repo:purge:recall-1:ingested');
    w.queueNoteRun.result = { kind: 'queued', jobId: 'job-2' };
    expect(await w.run('ingest')).toBe(200);
    expect(w.kickoffs[1]).toMatchObject({ durationSec: 1805, size: 4096 });
    expect(w.calls.filter((c) => c === 'repo:speakers')).toHaveLength(1);
  });

  it('ingested, yet the object is gone before its run was queued: an error, retried, and nothing queued', async () => {
    const w = world({ ingestedAt: '2026-09-28T01:31:00Z', billableSeconds: 1805 });
    await expect(w.run('ingest')).rejects.toThrow('notetaker_ingested_audio_missing');
    expect(w.calls).toEqual([]);
    expect(w.lines.find((l) => l.msg === 'notetaker_ingested_audio_missing')).toMatchObject({ level: 'error', noteId: 'mtg_7f0e' });
    // Once the run was queued, the object is the run's: a replay only finishes the tail.
    const v = world({ ingestedAt: '2026-09-28T01:31:00Z', billableSeconds: 1805, runQueuedAt: '2026-09-28T01:32:00Z' });
    v.queueNoteRun.result = { kind: 'in_flight', status: null };
    expect(await v.run('ingest')).toBe(200);
    expect(v.calls).toEqual(['kickoff:mtg_7f0e', 'repo:purge:recall-1:ingested', 'recall:delete_media:recall-1', 'repo:bot:done']);
  });

  it('a recording not done at Recall yet is retried, with nothing written', async () => {
    const w = world();
    w.recall.remote = { recordings: [recording({ media_shortcuts: { audio_mixed: { status: { code: 'processing' }, data: {} } } })] };
    await expect(w.run('ingest')).rejects.toThrow('notetaker_ingest_recording_not_ready');
    expect(w.calls).toEqual(['recall:get:recall-1']);
  });

  it('a download URL off the allowlist is never fetched, and nothing is saved or queued', async () => {
    const w = world();
    const evil = 'https://ec2-10-0-0-1.compute-1.amazonaws.com/audio.mp3';
    w.recall.remote = { recordings: [recording({ media_shortcuts: { ...recording().media_shortcuts, audio_mixed: { status: { code: 'done' }, data: { download_url: evil } } } })] };
    await expect(w.run('ingest')).rejects.toThrow('media URL not allowed');
    expect(w.calls.some((c) => c.startsWith('fetch:ec2'))).toBe(false);
    // On the recording's own trail, with its ids: not only the app's error line.
    expect(w.lines.find((l) => l.msg === 'notetaker_ingest_attempt_failed')).toMatchObject({
      level: 'warn', traceId: 'trace-1', userId: 'alice', workspaceId: 'workspace_alice', noteId: 'mtg_7f0e', meetingBotId: w.bot.id, attempt: 0,
    });
    expect(w.calls.some((c) => /store:write|repo:speakers|kickoff/.test(c))).toBe(false);
  });

  it('several recordings: the latest is ingested, and it\'s flagged', async () => {
    const w = world();
    w.recall.remote = { recordings: [recording({ id: 'old', started_at: '2026-09-28T00:00:00Z', completed_at: '2026-09-28T00:00:10Z' }), recording()] };
    await w.run('ingest');
    expect(w.calls).toContain('repo:ingested:1805');
    expect(w.lines.find((l) => l.msg === 'notetaker_multiple_recordings')).toMatchObject({ recordings: 2 });
  });

  it('a recording Recall gives no length for is settled at its reservation, and said so', async () => {
    const w = world();
    w.recall.remote = { recordings: [recording({ completed_at: null })] };
    await w.run('ingest');
    expect(w.calls).toContain(`repo:ingested:${90 * 60}`);
    expect(w.kickoffs[0].durationSec).toBe(90 * 60);
    expect(w.lines.find((l) => l.msg === 'notetaker_recording_length_unknown')).toMatchObject({ level: 'warn', reservedMinutes: 90 });
  });

  it('the note deleted while ingest ran: its audio is removed, Recall\'s copy too, and nothing is queued or charged', async () => {
    const w = world();
    w.repo.noteGone = true;
    expect(await w.run('ingest')).toBe(200);
    // Recall's purge is queued before anything that can fail, so a retry redoes the rest.
    expect(w.calls.slice(-5)).toEqual(['repo:speakers', 'repo:purge:recall-1:note_deleted', 'store:remove:workspace_alice/mtg_7f0e', 'recall:delete_media:recall-1', 'repo:bot:done']);
    expect(w.objects.size).toBe(0);
    expect(w.calls.some((c) => c.startsWith('repo:ingested') || c.startsWith('kickoff'))).toBe(false);
  });

  for (const [kind, reason] of [['not_found', 'note_deleted'], ['account_deleted', 'account_deleted']] as const) {
    it(`the kickoff finds the note gone (${kind}): the audio and Recall's copy go`, async () => {
      const w = world();
      w.queueNoteRun.result = { kind };
      expect(await w.run('ingest')).toBe(200);
      expect(w.calls.slice(-4)).toEqual([`repo:purge:recall-1:${reason}`, 'store:remove:workspace_alice/mtg_7f0e', 'recall:delete_media:recall-1', 'repo:bot:done']);
      expect(w.objects.size).toBe(0);
    });
  }

  it('a refusal (the service misconfigured) is the note\'s to say, and an error; the audio is ours, so Recall\'s copy still goes', async () => {
    const w = world();
    w.queueNoteRun.result = { kind: 'misconfigured', message: 'upgrading' };
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls.slice(-3)).toEqual(['repo:purge:recall-1:ingested', 'recall:delete_media:recall-1', 'repo:bot:done']);
    expect(w.lines.find((l) => l.msg === 'notetaker_kickoff_refused')).toMatchObject({ level: 'error', kind: 'misconfigured' });
    expect(w.objects.size).toBe(1);
  });

  it('Recall refusing the delete now leaves the purge queued for the worker, and the ingest done', async () => {
    const w = world();
    w.recall.deleteFails = new RecallError('busy', { status: 503 });
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls).toContain('repo:purge:recall-1:ingested');
    expect(w.lines.find((l) => l.msg === 'recall_media_delete_deferred')).toMatchObject({ level: 'warn', status: 503, recallBotId: 'recall-1' });

    // Our key or region refused is an error, as everywhere else Recall is called.
    const v = world();
    v.recall.deleteFails = new RecallError('no', { status: 401 });
    expect(await v.run('ingest')).toBe(200);
    expect(v.lines.find((l) => l.msg === 'recall_auth_failed')).toMatchObject({ level: 'error', status: 401, recallBotId: 'recall-1' });
  });

  it('Recall answering with a body that isn\'t JSON fails without quoting it (a bot\'s body holds presigned URLs)', async () => {
    const client = createRecallClient({
      apiKey: 'k', region: 'ap-northeast-1',
      fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers(), text: async () => '{"download_url":https://x.s3.amazonaws.com/a?X-Amz-Signature=sekrit' }),
    });
    const err = await client.getBot('recall-1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(RecallError);
    expect(err.message).toBe('recall GET /api/v1/bot/recall-1/: HTTP 200 body is not JSON');
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toMatch(/sekrit|X-Amz/);
  });

  it('a bot gone with its account has nothing to ingest', async () => {
    const w = world();
    expect(await w.run('ingest', { meetingBotId: 'nope' })).toBe(200);
    expect(w.calls).toEqual([]);
    expect(w.recallAsked()).toBe(0);
    expect(w.lines.map((l) => [l.msg, l.requestedBotId])).toEqual([['notetaker_ingest_nothing_to_do', 'invalid']]);
  });

  it('a note deleted before ingest ran (or by an earlier attempt of it) takes its meeting with it: Recall\'s copy and any audio', async () => {
    const w = world({ noteId: null });
    const noteId = noteIdForBot(w.bot.id);
    w.objects.set(`recordings/workspace_alice/${noteId}.mp3`, 4096);
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls).toEqual(['repo:purge:recall-1:note_deleted', `store:remove:workspace_alice/${noteId}`, 'recall:delete_media:recall-1', 'repo:bot:done']);
    expect(w.objects.size).toBe(0);
  });

  it('a bot that ended without its recording (the reconcile gave up on it) queues nothing when its media arrive late', async () => {
    for (const status of ['failed', 'cancelled']) {
      const w = world();
      w.bot.status = status;
      expect(await w.run('ingest')).toBe(200);
      expect(w.calls).toEqual([]);
      expect(w.lines.find((l) => l.msg === 'notetaker_ingest_bot_ended')).toMatchObject({ status });
    }
  });

  it('a bot never sent to Recall has nothing to ingest', async () => {
    const w = world();
    w.bot.recallBotId = null;
    expect(await w.run('ingest')).toBe(200);
    expect(w.calls).toEqual([]);
  });

  describe('on the last attempt', () => {
    const LAST = { 'x-cloudtasks-taskretrycount': '4' };

    it('a recording that never became ours fails its note (and queues Recall\'s purge, in the repo), rather than leave it recording', async () => {
      const w = world();
      w.recall.remote = { recordings: [] };
      expect(await w.run('ingest', { meetingBotId: w.bot.id }, LAST)).toBe(200);
      expect(w.calls).toEqual(['recall:get:recall-1', 'repo:dead_letter:ingest', 'repo:bot:failed:error']);
      expect(w.lines.find((l) => l.msg === 'notetaker_ingest_gave_up')).toMatchObject({ level: 'error', attempt: 4, noteId: 'mtg_7f0e', traceId: 'trace-1' });
    });

    it('one whose run was queued keeps it: only Recall\'s copy is left to the worker, and the bot ends', async () => {
      const w = world();
      w.repo.purgeFailsOnce = new Error('Connection terminated unexpectedly');
      expect(await w.run('ingest', { meetingBotId: w.bot.id }, LAST)).toBe(200);
      expect(w.calls.slice(-4)).toEqual(['repo:purge:recall-1:ingested', 'repo:dead_letter:ingest', 'repo:purge:recall-1:ingested', 'repo:bot:done']);
      expect(w.calls.some((c) => c.startsWith('repo:bot:failed'))).toBe(false);
    });

    it('giving up that itself fails still leaves the dead letter', async () => {
      const w = world();
      w.recall.remote = { recordings: [] };
      w.repo.failNotetaker = async () => { throw new Error('firestore unavailable'); };
      await expect(w.run('ingest', { meetingBotId: w.bot.id }, LAST)).rejects.toThrow('firestore unavailable');
      expect(w.calls).toContain('repo:dead_letter:ingest');
    });

    it('an earlier attempt still throws for Cloud Tasks to retry', async () => {
      const w = world();
      w.recall.remote = { recordings: [] };
      await expect(w.run('ingest', { meetingBotId: w.bot.id }, { 'x-cloudtasks-taskretrycount': '3' })).rejects.toThrow('notetaker_ingest_recording_not_ready');
      expect(w.calls).toEqual(['recall:get:recall-1']);
    });
  });
});

describe('purge_media', () => {
  const purge = (id: number, over: object = {}) => ({ id, recallBotId: `recall-${id}`, reason: 'ingested', leaveCall: false, attempts: 0, traceId: `trace-${id}`, ...over });

  it('asks Recall to delete each pending copy (leaving the call first when asked), and counts what failed', async () => {
    const w = world();
    w.repo.pending = [purge(1, { leaveCall: true }), purge(2)];
    w.recall.remote = { recordings: [{ status: { code: 'done' } }], status_changes: [{ code: 'done' }] };
    let n = 0;
    w.recall.deleteMedia = async (id: string) => { w.calls.push(`recall:delete_media:${id}`); if ((n += 1) === 2) throw new RecallError('recall POST: HTTP 500', { status: 500 }); };
    expect(await w.run('purge_media', {})).toBe(200);
    expect(w.lastBody()).toEqual({ ok: true, tried: 2, failed: 1, unrecorded: 0 });
    expect(w.calls).toEqual([
      'recall:leave:recall-1', 'recall:get:recall-1', 'recall:delete_media:recall-1', 'repo:attempt:1:ok',
      'recall:get:recall-2', 'recall:delete_media:recall-2', 'repo:attempt:2:recall POST: HTTP 500',
    ]);
  });

  it('a bot that ended holding nothing is confirmed without a delete; one Recall says it doesn\'t have is never taken as deleted', async () => {
    const w = world();
    w.repo.pending = [purge(1), purge(2, { reason: 'failed' })];
    w.recall.getBot = async (id: string) => {
      w.calls.push(`recall:get:${id}`);
      // A 404 is also what a wrong region or key answers: a failed attempt, a person's in the end.
      if (id === 'recall-1') throw new RecallError('recall GET: HTTP 404', { status: 404 });
      return { recordings: [], status_changes: [{ code: 'fatal' }] };
    };
    await w.run('purge_media', {});
    expect(w.calls).toEqual(['recall:get:recall-1', 'repo:attempt:1:recall GET: HTTP 404', 'recall:get:recall-2', 'repo:confirmed:recall-2']);
    expect(w.lines.find((l) => l.msg === 'recall_media_delete_failed')).toMatchObject({ level: 'warn', status: 404, recallBotId: 'recall-1' });
    expect(w.lines.filter((l) => l.msg === 'recall_purge_nothing_left').map((l) => l.recallBotId)).toEqual(['recall-2']);
  });

  it('Postgres failing to record an attempt is logged, and the batch and the exhausted alerts go on', async () => {
    const w = world();
    w.repo.pending = [purge(1), purge(2)];
    w.repo.exhausted = [purge(9, { attempts: 10 })];
    w.recall.remote = { recordings: [{ status: { code: 'done' } }], status_changes: [{ code: 'done' }] };
    w.recall.deleteFails = new RecallError('recall POST: HTTP 503', { status: 503 });
    w.repo.recordRecallPurgeAttempt = async (id: number) => { w.calls.push(`repo:attempt:${id}`); throw new Error('Connection terminated unexpectedly'); };
    expect(await w.run('purge_media', {})).toBe(200);
    expect(w.lastBody()).toEqual({ ok: true, tried: 2, failed: 2, unrecorded: 2 });
    const msgs = w.lines.map((l) => `${l.msg}:${l.recallBotId ?? ''}`);
    // Recall's refusal is on the trail before the write that failed, for each purge.
    expect(msgs.indexOf('recall_media_delete_failed:recall-1')).toBeLessThan(msgs.indexOf('recall_purge_record_failed:recall-1'));
    expect(msgs).toContain('recall_media_delete_failed:recall-2');
    expect(msgs).toContain('recall_purge_exhausted:recall-9');
    expect(w.lines.find((l) => l.msg === 'recall_purge_record_failed')).toMatchObject({ level: 'error', purgeId: 1, traceId: 'trace-1' });
  });

  it('a call already left is fine; any other Recall fault is an attempt that failed', async () => {
    const w = world();
    w.repo.pending = [purge(1, { leaveCall: true }), purge(2, { leaveCall: true })];
    w.recall.remote = { recordings: [{ status: { code: 'done' } }], status_changes: [{ code: 'call_ended' }] };
    let n = 0;
    w.recall.leaveCall = async (id: string) => { w.calls.push(`recall:leave:${id}`); throw new RecallError('x', { status: (n += 1) === 1 ? 400 : 401 }); };
    await w.run('purge_media', {});
    expect(w.calls).toEqual([
      'recall:leave:recall-1', 'recall:get:recall-1', 'recall:delete_media:recall-1', 'repo:attempt:1:ok',
      'recall:leave:recall-2', 'repo:attempt:2:x',
    ]);
    expect(w.lines.find((l) => l.msg === 'recall_media_delete_failed')).toMatchObject({ level: 'warn', status: 401, recallBotId: 'recall-2', traceId: 'trace-2' });
    expect(w.lines.find((l) => l.msg === 'recall_leave_already_gone')).toMatchObject({ status: 400, recallBotId: 'recall-1', traceId: 'trace-1' });
  });

  it('a run that overlaps another does nothing: two runs would each count an attempt against every purge', async () => {
    const w = world();
    w.repo.pending = [purge(1)];
    w.repo.lockHeld = true;
    expect(await w.run('purge_media', {})).toBe(200);
    expect(w.lastBody()).toEqual({ ok: true, skipped: true });
    expect(w.calls).toEqual([]);
    expect(w.lines.map((l) => l.msg)).toEqual(['recall_purges_skipped_overlap']);
  });

  it('nothing pending: Recall isn\'t asked; out of attempts: each is an error line, every run, until a person acts', async () => {
    const w = world();
    w.repo.exhausted = [purge(9, { attempts: 10, reason: 'note_deleted' })];
    await w.run('purge_media', {});
    await w.run('purge_media', {});
    expect(w.recallAsked()).toBe(0);
    const alerts = w.lines.filter((l) => l.msg === 'recall_purge_exhausted');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ level: 'error', recallBotId: 'recall-9', reason: 'note_deleted', attempts: 10, traceId: 'trace-9' });
  });
});

describe('the recordings store', () => {
  function fakeStorage() {
    const objects = new Map<string, { bytes: number; meta: any }>();
    // Noncurrent versions a plain delete would leave behind (the bucket is versioned).
    const versions: Array<{ name: string; generation: number }> = [];
    const seen: any = { buckets: [] as string[], deletes: [] as any[] };
    const storage = {
      bucket: (name: string) => {
        seen.buckets.push(name);
        return {
          getFiles: async ({ prefix, versions: all }: { prefix: string; versions: boolean }) => {
            expect(all).toBe(true);
            const live = [...objects.keys()].map((n) => ({ name: n, generation: 2 }));
            return [[...live, ...versions].filter((v) => v.name.startsWith(prefix)).map((v) => ({
              name: v.name,
              delete: async (opts: any) => {
                seen.deletes.push({ name: v.name, generation: v.generation, opts });
                if (v.generation === 2) objects.delete(v.name);
                else versions.splice(versions.indexOf(v), 1);
              },
            }))];
          },
          file: (path: string) => ({
            createWriteStream: (opts: any) => {
              let bytes = 0;
              return new Writable({
                write(chunk, _e, cb) { bytes += chunk.length; cb(); },
                // Finalised only when the stream ends cleanly, as a resumable upload is.
                final(cb) { objects.set(path, { bytes, meta: opts }); cb(); },
              });
            },
            exists: async () => [objects.has(path)],
            getMetadata: async () => [{ size: String(objects.get(path)?.bytes) }],
          }),
        };
      },
    };
    return { storage, objects, versions, seen };
  }

  it('streams into the bucket it was given, private and resumable, and reads the size back', async () => {
    const f = fakeStorage();
    const store = createRecordingsStore({ bucket: 'recordings-bucket', storage: f.storage });
    expect(await store.write('recordings/w/n.mp3', body(Buffer.alloc(1000)), { contentType: 'audio/mpeg', maxBytes: 2000 })).toBe(1000);
    expect(f.seen.buckets).toEqual(['recordings-bucket']);
    expect(f.objects.get('recordings/w/n.mp3')?.meta).toEqual({ contentType: 'audio/mpeg', resumable: true, metadata: { cacheControl: 'private, no-store' } });
    expect(await store.size('recordings/w/n.mp3')).toBe(1000);
    expect(await store.size('recordings/w/other.mp3')).toBeNull();
  });

  it('a deleted note\'s audio goes, every version of it, and nothing of another note', async () => {
    const f = fakeStorage();
    const store = createRecordingsStore({ bucket: 'b', storage: f.storage });
    await store.write('recordings/w/mtg_1.mp3', body('new'), { contentType: 'audio/mpeg', maxBytes: 100 });
    await store.write('recordings/w/mtg_10.mp3', body('other note'), { contentType: 'audio/mpeg', maxBytes: 100 });
    f.versions.push({ name: 'recordings/w/mtg_1.mp3', generation: 1 });
    await store.removeNote({ workspaceId: 'w', noteId: 'mtg_1' });
    expect(f.seen.deletes.map((d: any) => [d.name, d.generation])).toEqual([['recordings/w/mtg_1.mp3', 2], ['recordings/w/mtg_1.mp3', 1]]);
    expect([...f.objects.keys()]).toEqual(['recordings/w/mtg_10.mp3']);
    expect(f.versions).toEqual([]);
    await expect(store.removeNote({ workspaceId: 'w', noteId: '../x' })).rejects.toThrow('invalid');
  });

  it('a recording past the cap fails and leaves no object', async () => {
    const f = fakeStorage();
    const store = createRecordingsStore({ bucket: 'b', storage: f.storage });
    await expect(store.write('recordings/w/n.mp3', body(Buffer.alloc(3000)), { contentType: 'audio/mpeg', maxBytes: 2000 }))
      .rejects.toThrow('media larger than allowed');
    expect(f.objects.size).toBe(0);
  });

  it('no bucket configured: it says so when used, not when the service boots', async () => {
    const store = createRecordingsStore({ bucket: undefined, storage: fakeStorage().storage });
    await expect(store.size('x')).rejects.toThrow('GCS_BUCKET is not set');
  });
});
