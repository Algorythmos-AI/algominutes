import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// What the daily spend cap counts: the transcoder records paid work as each
// step starts (a speech job per chunk, a whole-file job, the fast path's Gemini
// call), with the duration it measured itself, never a client's number. A
// replay that re-polls a job already started records nothing new. Real
// Postgres; the network edges are fakes.
const require = createRequire(import.meta.url);
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const route = require('../../services/transcoder/src/route.js');
const geminiCall = require('@algominutes/ai/gemini-call.cjs');
const realLadder = geminiCall.callGeminiWithLadder;

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };

function deps(duration: number) {
  let op = 0;
  return {
    log, env: {}, traceId: 't-paid', db: transcoderDb,
    storage: { downloadToLocal: async (_p: string, local: string) => { fs.writeFileSync(local, 'audio'); }, uploadFromLocal: async (_l: string, p: string) => `gs://b/${p}`, deletePrefix: async () => {} },
    ffmpeg: {
      ensureTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'paid-work-')), cleanupTempDir: noop,
      probeDuration: async () => duration, extractChunk: async () => {},
    },
    stt: { startLongRunning: async () => `op-${op++}`, checkOperation: async () => ({ done: false }) },
    tasks: { enqueue: async () => {}, enqueueEmbedder: async () => {}, enqueueSummarizer: async () => {} },
    mirror: { mirrorStatus: async () => {}, mirrorProgress: async () => {}, mirrorReady: async () => {}, db: () => ({ doc: () => ({ update: async () => {} }) }) },
    fastPath: require('../../services/transcoder/src/fast-path.js'),
    youtube: {},
    terminalHooks: { onTranscodeTerminalFailure: async () => {} },
  };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', uid: 'u', type: 'recording', storagePath: 'recordings/ws/n1.aac' };
const events = async () => (await pool.query(
  `SELECT event, audio_seconds::float8 AS s, uid, workspace_id FROM usage_events WHERE note_id = 'n1' ORDER BY id`,
)).rows;

beforeEach(async () => {
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  geminiCall.callGeminiWithLadder = async () => ({
    model: 'gemini-3.5-flash',
    rawText: JSON.stringify({ transcript: [{ speaker: 'A', text: 'hi', time: '00:01' }], gist: 'g', actionItems: [], keyDecisions: [] }),
  });
});
afterAll(async () => {
  geminiCall.callGeminiWithLadder = realLadder;
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

describe('paid work is recorded as it starts', () => {
  it("a long recording: one speech job per chunk, each with that chunk's seconds; a replay adds nothing", async () => {
    await handler.handle(kickoff, deps(1500));
    const expected = route.planChunks(1500).map((c: any) => c.endSec - c.startSec);
    const rows = await events();
    expect(rows.map((r: any) => [r.event, r.s])).toEqual(expected.map((s: number) => ['stt_call', s]));
    expect(rows[0]).toMatchObject({ uid: 'u', workspace_id: 'ws' });

    await handler.handle(kickoff, deps(1500));
    expect(await events()).toHaveLength(expected.length);
  });

  it("a short clip: the fast path's Gemini call, for the whole clip, once an answer came back", async () => {
    await handler.handle(kickoff, deps(90));
    expect((await events()).map((r: any) => [r.event, r.s])).toEqual([['gemini_call', 90]]);
  });

  it("a Gemini outage (no answer, nothing billed) isn't counted, however often the task retries", async () => {
    geminiCall.callGeminiWithLadder = async () => ({ rawText: null, error: new Error('429 RESOURCE_EXHAUSTED') });
    for (let i = 0; i < 3; i++) await expect(handler.handle(kickoff, deps(90))).rejects.toThrow(/429/);
    expect(await events()).toEqual([]);
  });

  it('a whole-file provider job: once, for the whole file', async () => {
    const provider = { name: 'assemblyai', submit: async () => 'job-1' };
    await pool.query(`UPDATE notes SET status = 'chunking' WHERE id = 'n1'`);
    await handler.runWholeFilePath({
      noteId: 'n1', workspaceId: 'ws', inputLocal: '/tmp/x', durationSec: 3600, mimeType: 'audio/aac', provider, log, env: {}, deps: deps(3600),
      recordPaidWork: (event: string, s: number, model: string) => transcoderDb.recordPaidWork(transcoderDb.pool(), { noteId: 'n1', workspaceId: 'ws', uid: 'u', event, audioSeconds: s, model, log }),
    });
    expect((await events()).map((r: any) => [r.event, r.s])).toEqual([['stt_call', 3600]]);
  });

  it('an inline provider (Deepgram): every call, since no job id guards a replay', async () => {
    const provider = {
      name: 'deepgram', mode: 'inline',
      transcribeInline: async () => [{ speakerTag: 1, startMs: 0, endMs: 1000, text: 'hello', confidence: 0.9 }],
    };
    await pool.query(`UPDATE notes SET status = 'chunking' WHERE id = 'n1'`);
    const record = (event: string, s: number, model: string) => transcoderDb.recordPaidWork(transcoderDb.pool(), { noteId: 'n1', workspaceId: 'ws', uid: 'u', event, audioSeconds: s, model, log });
    await handler.runWholeFilePath({
      noteId: 'n1', workspaceId: 'ws', inputLocal: '/tmp/x', durationSec: 1800, mimeType: 'audio/aac', provider, log, env: {}, deps: deps(1800), recordPaidWork: record,
    });
    expect((await events()).map((r: any) => [r.event, r.s])).toEqual([['stt_call', 1800]]);
  });

  it('a note deleted before the record still counts the seconds (its id becomes null)', async () => {
    await transcoderDb.recordPaidWork(transcoderDb.pool(), { noteId: 'gone', workspaceId: 'ws', uid: 'u', event: 'stt_call', audioSeconds: 60, log });
    const rows = (await pool.query(`SELECT note_id, workspace_id, audio_seconds::float8 AS s FROM usage_events`)).rows;
    expect(rows).toEqual([{ note_id: null, workspace_id: 'ws', s: 60 }]);
  });

  it("a meter that can't write is logged and never fails the pipeline", async () => {
    const errors: string[] = [];
    const broken = { query: async () => { throw new Error('db down'); } };
    await transcoderDb.recordPaidWork(broken, { noteId: 'n1', workspaceId: 'ws', uid: 'u', event: 'stt_call', audioSeconds: 60, log: { error: (_o: unknown, m: string) => void errors.push(m) } });
    expect(errors).toEqual(['paid_work_record_failed']);
  });
});
