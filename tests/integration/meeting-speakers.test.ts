import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as repo from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A notetaker's transcript names its speakers (RELEASE.md PR 20, docs/plans/MEETINGS.md "Speaker names"): when
// a chunk's speech-to-text completes, each word goes to the speaker whose turn it falls in, from the meeting's
// own timeline saved at ingest, in place of the engine's diarisation. Every other note keeps its diarisation.
// Real Postgres, the real transcoder poll and line writer; the speech engine, Firestore and the queues are fakes.
const require = createRequire(import.meta.url);
const repoPath = require.resolve('@algominutes/db');
require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: repo } as never;
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const stt = require('../../services/transcoder/src/stt.js');
const assemblyai = require('../../services/transcoder/src/providers/assemblyai.js');
let assemblyOp: any = null;
assemblyai.poll = async () => assemblyOp;

const noop = () => {};
const infos: Array<{ o: any; m: string }> = [];
const log: any = { info: (o: any, m: string) => void infos.push({ o, m }), warn: noop, error: noop, child: () => log };
const at = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
// Google's result shape (stt.flattenWords): [startMs, endMs, word, the engine's own speaker label].
const googleOp = (words: Array<[number, number, string, string]>) => ({
  done: true,
  result: {
    results: {
      'gs://bucket/chunk': {
        transcript: {
          results: [{ alternatives: [{ words: words.map(([s, e, word, label]) => ({ startOffset: at(s), endOffset: at(e), word, speakerLabel: label })) }] }],
        },
      },
    },
  },
});

async function poll(chunkId: string, op: unknown, noteId = 'n1', workspaceId = 'ws', env: Record<string, string> = {}) {
  await handler.handleSttPoll({ kind: 'stt-poll', jobId: 'j', chunkId, noteId, workspaceId, poll: 0 }, {
    db: transcoderDb,
    stt: { checkOperation: async () => op, flattenWords: stt.flattenWords, wordsToLines: stt.wordsToLines },
    tasks: { enqueue: async () => {}, enqueueSummarizer: async () => {}, enqueueEmbedder: async () => {} },
    mirror: { db: () => ({}), mirrorProgress: async () => {}, mirrorStatus: async () => {} },
    storage: { deletePrefix: async () => {} },
    log,
    env,
    traceId: 't',
    terminalHooks: {},
  });
}

async function seedChunk(noteId: string, idx: number, startSec: number, endSec: number, status = 'pending', op = 'projects/p/operations/op'): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status, stt_operation_id)
       VALUES ($1, $2, $3, $4, 'chunks/x', $5, $6) RETURNING id`,
    [noteId, idx, startSec, endSec, status, op],
  );
  return rows[0].id;
}

// The meeting's timeline, as saveMeetingSpeakers stores it: [startMs, endMs, speaker tag].
async function timeline(noteId: string, turns: Array<[number, number, number]>) {
  let seq = 0;
  for (const [s, e, tag] of turns) {
    await pool.query(
      'INSERT INTO meeting_speaker_segments (note_id, seq, start_ms, end_ms, speaker_tag) VALUES ($1, $2, $3, $4, $5)',
      [noteId, seq++, s, e, tag],
    );
  }
}

const lines = async (noteId = 'n1') =>
  (await pool.query('SELECT speaker_tag, text FROM transcript_lines WHERE note_id = $1 ORDER BY start_ms', [noteId])).rows
    .map((r) => [r.speaker_tag, r.text]);

beforeEach(async () => {
  await resetDb();
  infos.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u', { chunksTotal: 1 });
  await pool.query(`UPDATE notes SET status = 'transcribing', source_kind = 'bot' WHERE id = 'n1'`);
});
afterAll(async () => {
  await pool.end();
  await repo.getPool().end();
});

describe('a notetaker transcript takes the meeting\'s speakers', () => {
  it('each word goes to the speaker whose turn it falls in, not the engine\'s guess; speech in no one\'s turn is unnamed', async () => {
    // Alice (1) until 5 s, Bob (2) from 5 s to 12 s; nobody from 12 s.
    await timeline('n1', [[0, 5000, 1], [5000, 12000, 2]]);
    const chunk = await seedChunk('n1', 0, 0, 600);
    await poll(chunk, googleOp([
      [500, 900, 'hello', 'spk_7'],
      [1000, 1400, 'everyone', 'spk_7'],
      [5200, 5600, 'hi', 'spk_7'],
      [6000, 6400, 'Alice', 'spk_3'],
      [30000, 30400, 'anyone?', 'spk_3'],
    ]));
    expect(await lines()).toEqual([[1, 'hello everyone'], [2, 'hi Alice'], [null, 'anyone?']]);
    expect(infos.find((i) => i.m === 'speakers_aligned')?.o).toMatchObject({ noteId: 'n1', workspaceId: 'ws', items: 5, unknown: 1, segments: 2 });
  });

  it('a later chunk\'s words are aligned at their place in the whole recording, not the chunk\'s', async () => {
    await pool.query(`UPDATE notes SET chunks_total = 2 WHERE id = 'n1'`);
    await seedChunk('n1', 0, 0, 600, 'done');
    // Bob speaks at 600-610 s of the meeting: 0-10 s into the second chunk.
    await timeline('n1', [[0, 600_000, 1], [600_000, 610_000, 2]]);
    const second = await seedChunk('n1', 1, 600, 1200);
    await poll(second, googleOp([[1000, 1500, 'later', 'spk_1']]));
    expect(await lines()).toEqual([[2, 'later']]);
  });

  it('a replayed poll writes the same lines', async () => {
    await timeline('n1', [[0, 5000, 1]]);
    const chunk = await seedChunk('n1', 0, 0, 600);
    const op = googleOp([[500, 900, 'hello', 'spk_7']]);
    await poll(chunk, op);
    await pool.query(`UPDATE audio_chunks SET status = 'pending' WHERE id = $1`, [chunk]);
    await poll(chunk, op);
    expect(await lines()).toEqual([[1, 'hello']]);
  });

  it('a whole-file provider\'s lines take the meeting\'s speakers too', async () => {
    await timeline('n1', [[0, 5000, 1], [5000, 12000, 2]]);
    const chunk = await seedChunk('n1', 0, 0, 600, 'pending', 'assemblyai:job-1');
    assemblyOp = {
      done: true,
      lines: [
        { speakerTag: 5, startMs: 500, endMs: 4000, text: 'hello everyone' },
        { speakerTag: 5, startMs: 5200, endMs: 9000, text: 'hi Alice' },
      ],
    };
    await poll(chunk, null, 'n1', 'ws', { STT_PROVIDER: 'assemblyai', ASSEMBLYAI_API_KEY: 'test' });
    expect(await lines()).toEqual([[1, 'hello everyone'], [2, 'hi Alice']]);
  });

  it('every other note keeps the engine\'s diarisation', async () => {
    await pool.query(`UPDATE notes SET source_kind = 'device' WHERE id = 'n1'`);
    const chunk = await seedChunk('n1', 0, 0, 600);
    await poll(chunk, googleOp([[500, 900, 'hello', 'spk_7'], [1000, 1400, 'there', 'spk_3']]));
    expect(await lines()).toEqual([[7, 'hello'], [3, 'there']]);
    expect(infos.some((i) => i.m === 'speakers_aligned')).toBe(false);
  });
});

describe('the reads, scoped to the task\'s workspace', () => {
  it('another workspace sees no source kind and no timeline for this note', async () => {
    await timeline('n1', [[0, 5000, 1]]);
    await seedUser('eve');
    await seedWorkspace('ws-eve', 'eve');
    const c = await pool.connect();
    try {
      expect(await transcoderDb.noteSourceKind(c, { noteId: 'n1', workspaceId: 'ws' })).toBe('bot');
      expect(await transcoderDb.speakerSegments(c, { noteId: 'n1', workspaceId: 'ws' })).toEqual([{ startMs: 0, endMs: 5000, speakerTag: 1 }]);
      expect(await transcoderDb.noteSourceKind(c, { noteId: 'n1', workspaceId: 'ws-eve' })).toBeNull();
      expect(await transcoderDb.speakerSegments(c, { noteId: 'n1', workspaceId: 'ws-eve' })).toEqual([]);
    } finally {
      c.release();
    }
  });
});
