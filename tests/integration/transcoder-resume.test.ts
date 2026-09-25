import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count } from './helpers';

// A kickoff Cloud Tasks replays (after a crash or a timeout) resumes where the
// last attempt stopped: a chunk whose speech job already runs isn't started (and
// paid for) again, a done chunk is left alone, and a note that moved on isn't
// dragged backwards. Poll tasks carry deterministic ids, so duplicate poll chains
// collapse. Real Postgres; the network edges (GCS, ffmpeg, STT, Tasks) are fakes.
const require = createRequire(import.meta.url);
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };

function deps({ duration = 1500 as number | Error, sttFailOn = -1, onProbe = async () => {} } = {}) {
  const extracted: number[] = [];
  const started: number[] = [];
  const enqueued: Array<{ payload: any; delay: number; taskId?: string }> = [];
  const terminal: any[] = [];
  const progress: any[] = [];
  const remirrored: any[] = [];
  let op = 0;
  const d = {
    log, env: {}, traceId: 't-resume',
    db: transcoderDb,
    storage: {
      downloadToLocal: async () => {},
      uploadFromLocal: async (_l: string, p: string) => `gs://bucket/${p}`,
    },
    ffmpeg: {
      ensureTempDir: () => '/tmp/transcoder-resume-test',
      cleanupTempDir: noop,
      probeDuration: async () => { await onProbe(); if (duration instanceof Error) throw duration; return duration; },
      extractChunk: async ({ startSec }: { startSec: number }) => { extracted.push(startSec / 600); },
    },
    stt: {
      startLongRunning: async ({ gcsUri }: { gcsUri: string }) => {
        const idx = Number(/chunk-(\d+)\.flac$/.exec(gcsUri)![1]);
        if (idx === sttFailOn) throw new Error('stt start failed');
        started.push(idx);
        return `op-${idx}-${op++}`;
      },
      checkOperation: async () => ({ done: false }),
    },
    tasks: { enqueue: async (payload: any, delay: number, taskId?: string) => { enqueued.push({ payload, delay, taskId }); } },
    mirror: {
      mirrorStatus: async () => {}, mirrorProgress: async (p: any) => { progress.push(p); }, mirrorError: async () => {},
      mirrorFinished: async (a: any) => { remirrored.push(a.state.status); },
      db: () => ({ doc: () => ({ update: async () => {} }) }),
    },
    fastPath: { run: async () => { throw new Error('fast path must not run for a long recording'); } },
    youtube: {},
    terminalHooks: { onTranscodeTerminalFailure: async (a: any) => { terminal.push(a); } },
  };
  return { d, extracted, started, enqueued, terminal, progress, remirrored };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', type: 'recording', storagePath: 'recordings/ws/n1.m4a' };
const chunks = async () => (await pool.query(
  `SELECT id, idx, status, stt_operation_id FROM audio_chunks WHERE note_id = 'n1' ORDER BY idx`,
)).rows;
const status = async () => (await pool.query(`SELECT status, error_message FROM notes WHERE id = 'n1'`)).rows[0];

beforeEach(async () => {
  await resetDb();
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u'); // 'queued', as markQueued leaves it
});
afterAll(async () => {
  await pool.end();
  await transcoderDb.pool().end();
  await getPool().end();
});

describe('transcoder kickoff, replayed', () => {
  it('a first kickoff starts every chunk once and names each first poll task', async () => {
    const f = deps();
    await handler.handle(kickoff, f.d);
    const rows = await chunks();
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2]);
    expect(f.started).toEqual([0, 1, 2]);
    expect(f.enqueued.map((e) => e.taskId)).toEqual(rows.map((r) => `${r.id}-stt-poll-0`));
    expect(f.enqueued.every((e) => e.delay === 60)).toBe(true);
    expect((await status()).status).toBe('transcribing');
  });

  it('a replay after a partial run starts only the chunk that never started, and re-polls the running one', async () => {
    const first = deps({ sttFailOn: 2 });
    await expect(handler.handle(kickoff, first.d)).rejects.toThrow(/stt start failed/);
    await pool.query(`UPDATE audio_chunks SET status = 'done' WHERE note_id = 'n1' AND idx = 0`);
    const [c0, c1] = await chunks();

    const replay = deps();
    await handler.handle(kickoff, replay.d);
    expect(replay.extracted).toEqual([2]); // no work for chunks 0 and 1
    expect(replay.started).toEqual([2]); // no second paid job for chunk 1
    const rows = await chunks();
    expect(rows[1].stt_operation_id).toBe(c1.stt_operation_id); // chunk 1 keeps its job
    expect(replay.enqueued.map((e) => e.taskId)).toEqual([`${c1.id}-stt-poll-0`, `${rows[2].id}-stt-poll-0`]);
    expect(replay.enqueued.some((e) => e.payload.chunkId === c0.id)).toBe(false);
  });

  // It changes nothing in Postgres and starts nothing; a finished note's doc is
  // brought in line with Postgres (kickoff-remirror.test.ts has the detail).
  it.each(['summarizing', 'ready', 'error'])('a replay after the note moved on (%s) changes nothing', async (s) => {
    await pool.query(`UPDATE notes SET status = $1 WHERE id = 'n1'`, [s]);
    const f = deps();
    await handler.handle(kickoff, f.d);
    expect((await status()).status).toBe(s);
    expect(f.started).toEqual([]);
    expect(f.enqueued).toEqual([]);
    expect(await count(`SELECT 1 FROM audio_chunks`)).toBe(0);
    expect(f.remirrored).toEqual(s === 'summarizing' ? [] : [s]);
  });

  // An attempt that stalled (past Cloud Tasks' dispatch deadline) wakes up after
  // its replay finished the note: its later status writes are conditional.
  it('a note that finishes while this attempt is mid-way is left alone: no status write, no chunk, no poll', async () => {
    const f = deps({ onProbe: async () => { await pool.query(`UPDATE notes SET status = 'ready' WHERE id = 'n1'`); } });
    await expect(handler.handle(kickoff, f.d)).resolves.toBeUndefined();
    expect((await status()).status).toBe('ready');
    expect(f.started).toEqual([]);
    expect(f.enqueued).toEqual([]);
  });

  it("a replay that finds a failed chunk re-marks the note failed, and starts nothing", async () => {
    const first = deps();
    await handler.handle(kickoff, first.d);
    await pool.query(`UPDATE audio_chunks SET status = 'error' WHERE note_id = 'n1' AND idx = 1`);
    const replay = deps();
    await handler.handle(kickoff, replay.d);
    expect(replay.started).toEqual([]);
    expect((await status()).status).toBe('error');
  });

  it("a poll for a chunk whose run already failed stops (a late chain can't revive it)", async () => {
    const f = deps();
    await handler.handle(kickoff, f.d);
    const [c0] = await chunks();
    await pool.query(`UPDATE audio_chunks SET status = 'error' WHERE id = $1`, [c0.id]);
    const poll = deps();
    await handler.handle({ kind: 'stt-poll', jobId: 'j', chunkId: c0.id, noteId: 'n1', workspaceId: 'ws', poll: 3 }, poll.d);
    expect(poll.enqueued).toEqual([]);
  });

  it('a replay mirrors the progress Postgres holds, not zero', async () => {
    const first = deps();
    await handler.handle(kickoff, first.d);
    await pool.query(`UPDATE notes SET chunks_done = 2 WHERE id = 'n1'`);
    const replay = deps();
    await handler.handle(kickoff, replay.d);
    expect(replay.progress).toEqual([{ workspaceId: 'ws', noteId: 'n1', done: 2, total: 3 }]);
  });

  it('ffprobe/ffmpeg failing to run is retried, not reported as a damaged recording', async () => {
    const f = deps({ duration: Object.assign(new Error('could not determine duration'), { transient: true }) });
    await expect(handler.handle(kickoff, f.d)).rejects.toThrow(/could not determine duration/);
    expect((await status()).status).not.toBe('error');
    expect(f.terminal).toEqual([]);
  });

  it("an unreadable duration fails the note for good (no retry), and never takes the fast path", async () => {
    const f = deps({ duration: new Error('could not determine duration') });
    await expect(handler.handle(kickoff, f.d)).resolves.toBeUndefined();
    expect(await status()).toMatchObject({ status: 'error', error_message: expect.stringMatching(/couldn't read this recording's length/) });
    expect(f.terminal).toHaveLength(1);
    expect(f.enqueued).toEqual([]);
  });

  it('each poll re-enqueues under the next deterministic id', async () => {
    const f = deps();
    await handler.handle(kickoff, f.d);
    const [c0] = await chunks();
    const poll = deps();
    await handler.handle({ kind: 'stt-poll', jobId: 'j', chunkId: c0.id, noteId: 'n1', workspaceId: 'ws', poll: 4 }, poll.d);
    expect(poll.enqueued).toEqual([{ payload: expect.objectContaining({ poll: 5, chunkId: c0.id }), delay: 60, taskId: `${c0.id}-stt-poll-5` }]);
  });
});
