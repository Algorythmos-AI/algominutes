import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The fast path commits its result to Postgres, then mirrors it. A retry of the
// task finds the note finished and acknowledges it without coming back, so a
// mirror that fails after the commit must not throw: throwing only skipped the
// embedder (the note was never searchable) and, with the kickoff's error mirror
// gone, bought nothing. It is logged instead. Real Postgres; Gemini, Firestore
// and Cloud Tasks are fakes.
const require = createRequire(import.meta.url);
const geminiCall = require('@algominutes/ai/gemini-call.cjs');
const realLadder = geminiCall.callGeminiWithLadder;
const fastPath = require('../../services/transcoder/src/fast-path.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const { NoteGoneError } = require('../../services/transcoder/src/note-gone.js');

const noop = () => {};
const errors: string[] = [];
const log: any = { info: noop, warn: noop, error: (_o: unknown, m: string) => void errors.push(m), child: () => log };

async function run(mirrorReady: () => Promise<void>) {
  const embeds: any[] = [];
  const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-mirror-')), 'clip.aac');
  fs.writeFileSync(input, Buffer.from('not really audio'));
  const done = fastPath.run({
    noteId: 'n1', workspaceId: 'ws', type: 'recording', mimeType: 'audio/aac', inputLocal: input, durationSec: 62, log,
    deps: { db: transcoderDb, mirror: { mirrorReady }, tasks: { enqueueEmbedder: async (a: any) => void embeds.push(a) }, env: {} },
  });
  return { done, embeds };
}

beforeEach(async () => {
  await resetDb();
  errors.length = 0;
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
  await pool.query(`UPDATE notes SET status = 'chunking' WHERE id = 'n1'`);
  geminiCall.callGeminiWithLadder = async () => ({
    model: 'gemini-3.5-flash',
    rawText: JSON.stringify({ transcript: [{ speaker: 'A', text: 'hello', time: '00:05' }], gist: 'g', actionItems: ['a'], keyDecisions: [] }),
  });
});
afterAll(async () => {
  geminiCall.callGeminiWithLadder = realLadder;
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

describe('fast path: the mirror after the commit', () => {
  it('a Firestore blip is logged, and the note is still queued for search', async () => {
    const r = await run(async () => { throw Object.assign(new Error('14 UNAVAILABLE: blip'), { code: 14 }); });
    await expect(r.done).resolves.toBeUndefined();
    expect((await pool.query(`SELECT status, embedder_enqueued_at IS NOT NULL AS claimed FROM notes WHERE id = 'n1'`)).rows[0])
      .toEqual({ status: 'ready', claimed: true });
    expect(r.embeds).toEqual([{ noteId: 'n1', workspaceId: 'ws' }]);
    expect(errors).toContain('fast_path_ready_mirror_failed');
  });

  it("a doc that's gone still throws, for handle() to check against Postgres", async () => {
    const r = await run(async () => { throw new NoteGoneError('firestore'); });
    await expect(r.done).rejects.toBeInstanceOf(NoteGoneError);
  });

  it('a mirror that lands: no error line', async () => {
    const r = await run(async () => {});
    await r.done;
    expect(errors).not.toContain('fast_path_ready_mirror_failed');
    expect(r.embeds).toHaveLength(1);
  });
});
