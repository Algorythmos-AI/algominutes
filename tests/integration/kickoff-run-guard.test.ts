import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// A kickoff task carries the run it was queued for (notes.run_seq; audit Q12). One from a run the note has
// since left (re-queued after IN_FLIGHT_STALE_MS) is acknowledged and does nothing: the new run's own task does
// the work. A task from before runSeq was carried goes on as before. Real Postgres.
const require = createRequire(import.meta.url);
const handler = require('../../services/transcoder/src/handler.js');
const transcoderDb = require('../../services/transcoder/src/db.js');

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws', 'alice');
  await seedNote('n1', 'ws', 'alice');
  await pool.query(`UPDATE notes SET status = 'queued', run_seq = 2 WHERE id = 'n1'`);
});
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

function deps() {
  const said: string[] = [];
  const noop = () => {};
  const log: any = { info: (_o: unknown, m: string) => void said.push(m), warn: noop, error: noop, child: () => log };
  const work: string[] = [];
  return {
    said, work,
    d: {
      log, env: {}, traceId: 't-run', db: transcoderDb,
      storage: { downloadToLocal: async (_p: string, local: string) => { work.push('download'); fs.writeFileSync(local, 'audio'); } },
      ffmpeg: { ensureTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'run-guard-')), cleanupTempDir: noop, probeDuration: async () => 90 },
      stt: {}, youtube: {}, tasks: {},
      mirror: { mirrorStatus: async () => void work.push('mirror'), mirrorProgress: async () => {}, db: () => ({ doc: () => ({ update: async () => {} }) }) },
      fastPath: { run: async () => void work.push('fast') },
      terminalHooks: { onTranscodeTerminalFailure: async () => {} },
      meter: { settleMeasuredLength: async () => ({ kind: 'settled', chargedMinutes: 2, deltaMinutes: 0 }) },
    },
  };
}
const kickoff = (over: Record<string, unknown> = {}) => ({ kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', uid: 'alice', type: 'recording', storagePath: 'recordings/ws/n1.m4a', ...over });
const status = async () => (await pool.query(`SELECT status FROM notes WHERE id = 'n1'`)).rows[0].status;

describe("a kickoff from a run the note has left", () => {
  it('is acknowledged and does nothing: no status write, no download, no paid work', async () => {
    const x = deps();
    await expect(handler.handle(kickoff({ runSeq: 1 }), x.d)).resolves.toBeUndefined();
    expect(x.said).toContain('kickoff_superseded_by_new_run');
    expect(x.work).toEqual([]);
    expect(await status()).toBe('queued');
  });

  it("the note's current run goes on", async () => {
    const x = deps();
    await handler.handle(kickoff({ runSeq: 2 }), x.d);
    expect(x.said).not.toContain('kickoff_superseded_by_new_run');
    expect(x.work).toContain('download');
  });

  it('a task from before runSeq was carried goes on as before', async () => {
    const x = deps();
    await handler.handle(kickoff(), x.d);
    expect(x.said).not.toContain('kickoff_superseded_by_new_run');
    expect(x.work).toContain('download');
  });
});
