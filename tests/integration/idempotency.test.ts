import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { PoolClient } from 'pg';
import {
  getPool,
  meterMinutes,
  reverseUsageForNote,
  usedMinutes,
  ensureTrial,
  registerPushToken,
  tokensForUser,
} from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote, count, quietLog } from './helpers';

// CLAUDE.md §1 Idempotency: replaying a Cloud Task must not produce duplicate
// rows. These pin the replay behaviour of the writers the pipeline relies on.
const require = createRequire(import.meta.url);
const transcoderDb = require('../../services/transcoder/src/db.js');

let client: PoolClient;
beforeEach(async () => {
  await resetDb();
  await seedUser('u1');
  await seedWorkspace('w1', 'u1');
  await seedNote('n1', 'w1', 'u1', { chunksTotal: 2 });
  client?.release();
  client = await pool.connect();
});
afterAll(async () => {
  client?.release();
  await pool.end();
  await getPool().end();
});

describe('transcoder chunk pipeline (services/transcoder/src/db.js)', () => {
  const chunk = (idx: number) => ({ noteId: 'n1', idx, startSec: idx * 600, endSec: idx * 600 + 630, storagePath: `c/${idx}.flac` });

  it('insertAudioChunkRow: a replay returns the same row, never a second one', async () => {
    const a = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    const b = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    expect(b).toBe(a);
    expect(await count(`SELECT 1 FROM audio_chunks WHERE note_id = 'n1'`)).toBe(1);
  });

  it('insertTranscriptLines: a replay writes no duplicate lines', async () => {
    const chunkId = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    const lines = [
      { startMs: 0, endMs: 1000, text: 'hello there', confidence: 0.9 },
      { startMs: 1000, endMs: 2000, text: 'general kenobi', confidence: 0.9 },
    ];
    await transcoderDb.insertTranscriptLines(client, { noteId: 'n1', chunkId, lines, log: quietLog });
    await transcoderDb.insertTranscriptLines(client, { noteId: 'n1', chunkId, lines, log: quietLog });
    expect(await count(`SELECT 1 FROM transcript_lines WHERE note_id = 'n1'`)).toBe(2);
  });

  it('insertTranscriptLines: PII is redacted before it is stored (CLAUDE.md §1)', async () => {
    const chunkId = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    await transcoderDb.insertTranscriptLines(client, {
      noteId: 'n1',
      chunkId,
      lines: [{ startMs: 0, endMs: 1000, text: 'email me at jane.doe@example.com', confidence: 0.9 }],
      log: quietLog,
    });
    const { rows } = await pool.query(`SELECT text FROM transcript_lines WHERE note_id = 'n1'`);
    expect(rows[0].text).toContain('<<REDACTED:EMAIL>>');
    expect(rows[0].text).not.toContain('jane.doe@example.com');
  });

  it('markChunkDone: true only once every planned chunk is done, and stable under replay', async () => {
    const c0 = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    const c1 = await transcoderDb.insertAudioChunkRow(client, chunk(1));
    expect(await transcoderDb.markChunkDone(client, { chunkId: c0, noteId: 'n1' })).toBe(false);
    expect(await transcoderDb.markChunkDone(client, { chunkId: c1, noteId: 'n1' })).toBe(true);
    expect(await transcoderDb.markChunkDone(client, { chunkId: c1, noteId: 'n1' })).toBe(true);
    const { rows } = await pool.query(`SELECT chunks_done FROM notes WHERE id = 'n1'`);
    expect(rows[0].chunks_done).toBe(2);
  });

  it('markChunkDone: never reports done while the chunk plan is unknown', async () => {
    await pool.query(`UPDATE notes SET chunks_total = NULL WHERE id = 'n1'`);
    const c0 = await transcoderDb.insertAudioChunkRow(client, chunk(0));
    expect(await transcoderDb.markChunkDone(client, { chunkId: c0, noteId: 'n1' })).toBe(false);
  });

  it('claimSummarizerEnqueue / claimEmbedderEnqueue: exactly once each', async () => {
    expect(await transcoderDb.claimSummarizerEnqueue(client, 'n1')).toBe(true);
    expect(await transcoderDb.claimSummarizerEnqueue(client, 'n1')).toBe(false);
    expect(await transcoderDb.claimEmbedderEnqueue(client, 'n1')).toBe(true);
    expect(await transcoderDb.claimEmbedderEnqueue(client, 'n1')).toBe(false);
  });
});

describe('usage ledger (packages/db usage-repo)', () => {
  it('meterMinutes: the same idempotency key debits once', async () => {
    const input = { uid: 'u1', workspaceId: 'w1', noteId: 'n1', minutes: 42, idempotencyKey: 'n1:ingest', billingPeriod: '2026-09' };
    expect((await meterMinutes(input)).applied).toBe(true);
    expect((await meterMinutes(input)).applied).toBe(false);
    expect(await usedMinutes('u1', '2026-09')).toBe(42);
  });

  it('reverseUsageForNote: refunds the net debit once, never over-refunds', async () => {
    await meterMinutes({ uid: 'u1', noteId: 'n1', minutes: 30, idempotencyKey: 'n1:ingest', billingPeriod: '2026-09' });
    const refund = { noteId: 'n1', reason: 'transcode_failed', idempotencyKey: 'n1:refund:transcode_failed' };
    await reverseUsageForNote(refund);
    await reverseUsageForNote(refund);
    expect(await usedMinutes('u1', '2026-09')).toBe(0);
  });
});

describe('subscriptions + push tokens', () => {
  it('ensureTrial: a replay keeps the single original trial', async () => {
    const first = await ensureTrial('u1', { platform: 'ios' });
    const second = await ensureTrial('u1', { platform: 'ios' });
    expect(await count(`SELECT 1 FROM subscriptions WHERE uid = 'u1'`)).toBe(1);
    expect(String(second.trial_ends_at)).toBe(String(first.trial_ends_at));
  });

  it('registerPushToken: a token that moves accounts is re-homed, not duplicated', async () => {
    await seedUser('u2');
    await registerPushToken({ token: 'tok-1', uid: 'u1', platform: 'ios' });
    await registerPushToken({ token: 'tok-1', uid: 'u2', platform: 'ios' });
    expect(await count(`SELECT 1 FROM push_tokens WHERE token = 'tok-1'`)).toBe(1);
    expect((await tokensForUser('u1')).length).toBe(0);
    expect((await tokensForUser('u2')).map((t) => t.token)).toEqual(['tok-1']);
  });
});
