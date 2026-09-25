import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace, seedNote } from './helpers';

// The spend reader behind the daily cap: the audio minutes the transcoder sent
// to paid work in the last 24 hours (usage_events), times a blended cost per
// minute. Real Postgres.
const require = createRequire(import.meta.url);
const { createPaidWorkSpendReader, cogsPerMinuteAUD, DEFAULT_COGS_AUD_PER_MINUTE } = require('@algominutes/db/spend-repo.cjs');

const paid = (noteId: string, seconds: number | null, ago = '1 hour', event = 'stt_call') => pool.query(
  `INSERT INTO usage_events (uid, workspace_id, note_id, event, audio_seconds, created_at)
   VALUES ('alice', 'ws-a', $1, $4, $2, NOW() - $3::interval)`,
  [noteId, seconds, ago, event],
);

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedWorkspace('ws-a', 'alice');
  await seedNote('n1', 'ws-a', 'alice');
  await seedNote('n2', 'ws-a', 'alice');
});
afterAll(async () => { await pool.end(); });

describe('createPaidWorkSpendReader', () => {
  it("sums the last 24 hours' paid audio across notes; older work and rows without audio don't count", async () => {
    await paid('n1', 600);
    await paid('n2', 300, '23 hours', 'gemini_call');
    await paid('n1', 6000, '25 hours');
    await paid('n2', null);
    const read = createPaidWorkSpendReader({ pool: () => pool, ratePerMinute: 0.1 });
    expect(await read()).toBeCloseTo(1.5);
  });

  it('caches for a minute, then reads again', async () => {
    let t = 1_000_000;
    const read = createPaidWorkSpendReader({ pool: () => pool, ratePerMinute: 1, now: () => t });
    await paid('n1', 600);
    expect(await read()).toBe(10);
    await paid('n1', 300);
    t += 59_000;
    expect(await read()).toBe(10);
    t += 2_000;
    expect(await read()).toBe(15);
  });

  it('nothing paid for is 0, not null', async () => {
    expect(await createPaidWorkSpendReader({ pool: () => pool })()).toBe(0);
  });
});

describe('cogsPerMinuteAUD', () => {
  it('COGS_AUD_PER_MINUTE when it is a positive number, else the default', () => {
    expect(cogsPerMinuteAUD({ COGS_AUD_PER_MINUTE: '0.012' })).toBe(0.012);
    for (const bad of [undefined, '', '0', '-1', 'abc']) {
      expect(cogsPerMinuteAUD({ COGS_AUD_PER_MINUTE: bad })).toBe(DEFAULT_COGS_AUD_PER_MINUTE);
    }
  });
});
