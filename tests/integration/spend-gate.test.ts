import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The transcoder's spend gate: at the daily cap a kickoff's note is failed in
// Postgres (then Firestore), refunded and its author told, instead of the task
// being dropped with the note left in progress. A poll isn't gated: its speech
// job is already paid for. Real Postgres; Firestore and the hooks are fakes.
const require = createRequire(import.meta.url);
const { spendGate } = require('../../services/transcoder/src/spend-gate.js');
const transcoderDb = require('../../services/transcoder/src/db.js');
const noteTerminal = require('@algominutes/db/note-terminal.cjs');
const spendGuard = require('@algominutes/ai/spend-guard.cjs');

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
const mirrored: any[] = [];
const fsStub = { doc: () => ({ update: async (data: any) => void mirrored.push(data) }) };

function deps() {
  const terminal: any[] = [];
  return {
    terminal,
    d: {
      db: transcoderDb, mirror: { db: () => fsStub }, log, traceId: 't-cap', noteTerminal, spendGuard,
      terminalHooks: { onTranscodeTerminalFailure: async (a: any) => void terminal.push(a) },
    },
  };
}
const kickoff = { kind: 'kickoff', noteId: 'n1', workspaceId: 'ws', type: 'recording', storagePath: 'recordings/ws/n1.aac' };
const note = async () => (await pool.query(`SELECT status, error_message FROM notes WHERE id = 'n1'`)).rows[0];

beforeEach(async () => {
  await resetDb();
  mirrored.length = 0;
  process.env.DAILY_SPEND_CAP_AUD = '10';
  await seedUser('u');
  await seedWorkspace('ws', 'u');
  await seedNote('n1', 'ws', 'u');
});
afterEach(() => { delete process.env.DAILY_SPEND_CAP_AUD; spendGuard.setDailySpendReader(async () => 0); });
afterAll(async () => {
  await transcoderDb.pool().end();
  await pool.end();
  await getPool().end();
});

describe('transcoder spend gate', () => {
  it('at the cap, a kickoff fails its note (Postgres, then Firestore), runs the refund hook once, and acks', async () => {
    spendGuard.setDailySpendReader(async () => 12);
    const f = deps();
    expect(await spendGate(kickoff, f.d)).toEqual({ status: 200, body: { ok: false, reason: 'spend_cap' } });
    expect(await note()).toEqual({ status: 'error', error_message: spendGuard.SPEND_CAP_MESSAGE });
    expect(mirrored).toEqual([expect.objectContaining({ status: 'error', errorMessage: spendGuard.SPEND_CAP_MESSAGE })]);
    expect(f.terminal).toHaveLength(1);
    expect(f.terminal[0]).toMatchObject({ noteId: 'n1', workspaceId: 'ws', traceId: 't-cap', payload: { kind: 'kickoff', storagePath: 'recordings/ws/n1.aac' } });
    expect(f.terminal[0].err.code).toBe('SPEND_CAP_EXCEEDED');
  });

  it("at the cap, a poll isn't stopped: its speech job is already paid for", async () => {
    spendGuard.setDailySpendReader(async () => 12);
    const f = deps();
    expect(await spendGate({ kind: 'stt-poll', chunkId: 'c', noteId: 'n1', workspaceId: 'ws' }, f.d)).toBeNull();
    expect((await note()).status).toBe('queued');
    expect(f.terminal).toEqual([]);
  });

  it('under the cap, a kickoff carries on', async () => {
    spendGuard.setDailySpendReader(async () => 3);
    const f = deps();
    expect(await spendGate(kickoff, f.d)).toBeNull();
    expect((await note()).status).toBe('queued');
  });

  it("at the cap with a workspace the note isn't in: the note isn't failed or mirrored", async () => {
    spendGuard.setDailySpendReader(async () => 12);
    const f = deps();
    await spendGate({ ...kickoff, workspaceId: 'ws-other' }, f.d);
    expect((await note()).status).toBe('queued');
    expect(mirrored).toEqual([]);
  });
});
