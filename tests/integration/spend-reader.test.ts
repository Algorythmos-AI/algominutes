import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { pool, resetDb, seedUser, seedWorkspace } from './helpers';

// The spend reader behind the daily cap: minutes debited in usage_ledger over
// the last 24 hours, times a blended cost per minute. Real Postgres.
const require = createRequire(import.meta.url);
const { createLedgerSpendReader, cogsPerMinuteAUD, DEFAULT_COGS_AUD_PER_MINUTE } = require('@algominutes/db/spend-repo.cjs');

let n = 0;
const entry = (uid: string, type: 'debit' | 'reversal', minutes: number, ago = '1 hour', reason = type === 'debit' ? 'ingest' : 'refund:transcode_failed') => pool.query(
  `INSERT INTO usage_ledger (uid, entry_type, minutes, billing_period, reason, idempotency_key, created_at)
   VALUES ($1, $2, $3, '2026-09', $6, $4, NOW() - $5::interval)`,
  [uid, type, minutes, `k${n++}`, ago, reason],
);

beforeEach(async () => {
  await resetDb();
  await seedUser('alice');
  await seedUser('bob');
  await seedWorkspace('ws-a', 'alice');
});
afterAll(async () => { await pool.end(); });

describe('createLedgerSpendReader', () => {
  it("sums the last 24 hours' debits across accounts; refunds and older debits don't count", async () => {
    await entry('alice', 'debit', 60);
    await entry('bob', 'debit', 30, '23 hours');
    await entry('alice', 'reversal', -60);
    await entry('bob', 'debit', 500, '25 hours');
    const read = createLedgerSpendReader({ pool: () => pool, ratePerMinute: 0.1 });
    expect(await read()).toBeCloseTo(9);
  });

  it("a note the cap stopped nets out (nothing was paid for), so capped uploads can't hold the cap shut", async () => {
    await entry('alice', 'debit', 60);
    await entry('alice', 'debit', 40);
    await entry('alice', 'reversal', -40, '1 hour', 'refund:spend_cap');
    const read = createLedgerSpendReader({ pool: () => pool, ratePerMinute: 1 });
    expect(await read()).toBe(60);
  });

  it("a cap refund that outlives its debit in the window doesn't go below 0", async () => {
    await entry('alice', 'reversal', -40, '1 hour', 'refund:spend_cap');
    expect(await createLedgerSpendReader({ pool: () => pool, ratePerMinute: 1 })()).toBe(0);
  });

  it('caches for a minute, then reads again', async () => {
    let t = 1_000_000;
    const read = createLedgerSpendReader({ pool: () => pool, ratePerMinute: 1, now: () => t });
    await entry('alice', 'debit', 10);
    expect(await read()).toBe(10);
    await entry('alice', 'debit', 5);
    t += 59_000;
    expect(await read()).toBe(10);
    t += 2_000;
    expect(await read()).toBe(15);
  });

  it('an empty ledger is 0, not null', async () => {
    expect(await createLedgerSpendReader({ pool: () => pool })()).toBe(0);
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
