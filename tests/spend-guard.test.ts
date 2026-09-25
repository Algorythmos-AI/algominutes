import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The §4.6 daily cap as a worker's gate: at the cap the note is failed (Postgres
// first), refunded and its author told, and the task acknowledged, instead of
// the task being dropped with the note left in progress.
const require = createRequire(import.meta.url);
const spendGuard = require('@algominutes/ai/spend-guard.cjs');

const noop = () => {};
const errors: string[] = [];
const log: any = { info: noop, warn: noop, error: (_o: unknown, m: string) => void errors.push(m) };

function gate({ spent, markFailed = async () => {}, noteId = 'n1' as string | null }: { spent: number | (() => Promise<number>); markFailed?: () => Promise<void>; noteId?: string | null }) {
  spendGuard.setDailySpendReader(typeof spent === 'function' ? spent : async () => spent);
  const calls: string[] = [];
  let cappedErr: any;
  const run = spendGuard.haltAtSpendCap({
    log, noteId, workspaceId: 'ws',
    markFailed: async () => { calls.push('markFailed'); await markFailed(); },
    onCapped: async (err: unknown) => { calls.push('onCapped'); cappedErr = err; },
  });
  return { run, calls, cappedErr: () => cappedErr };
}

beforeEach(() => { errors.length = 0; process.env.DAILY_SPEND_CAP_AUD = '10'; });
afterEach(() => { delete process.env.DAILY_SPEND_CAP_AUD; spendGuard.setDailySpendReader(async () => 0); });

describe('haltAtSpendCap', () => {
  it('under the cap: carries on, touching nothing', async () => {
    const g = gate({ spent: 9.99 });
    expect(await g.run).toBeNull();
    expect(g.calls).toEqual([]);
  });

  it('at the cap: fails the note first, then runs the terminal hooks, and acks', async () => {
    const g = gate({ spent: 10 });
    expect(await g.run).toEqual({ status: 200, body: { ok: false, reason: 'spend_cap' } });
    expect(g.calls).toEqual(['markFailed', 'onCapped']);
    expect(g.cappedErr().code).toBe('SPEND_CAP_EXCEEDED');
    expect(errors).toContain('spend_cap_tripped_pipeline_halted');
  });

  it("at the cap with Postgres down: 500 so the task retries, and no refund for a note that isn't failed", async () => {
    const g = gate({ spent: 50, markFailed: async () => { throw new Error('connection refused'); } });
    expect(await g.run).toEqual({ status: 500, body: { error: 'note_write_failed' } });
    expect(g.calls).toEqual(['markFailed']);
    expect(errors).toContain('spend_cap_note_write_failed');
  });

  it('at the cap with no note in the task: acks, with nothing to mark', async () => {
    const g = gate({ spent: 50, noteId: null });
    expect(await g.run).toEqual({ status: 200, body: { ok: false, reason: 'spend_cap' } });
    expect(g.calls).toEqual([]);
  });

  it("a broken reader fails open (logged): a meter outage mustn't stop the product", async () => {
    const g = gate({ spent: async () => { throw new Error('db down'); } });
    expect(await g.run).toBeNull();
    expect(errors).toContain('spend_guard_reader_failed');
  });
});

describe('the per-environment cap', () => {
  it('reads ALGOMINUTES_ENV before NODE_ENV, so staging on NODE_ENV=production gets its own cap', () => {
    delete process.env.DAILY_SPEND_CAP_AUD;
    const saved = { a: process.env.ALGOMINUTES_ENV, n: process.env.NODE_ENV };
    try {
      process.env.NODE_ENV = 'production';
      process.env.ALGOMINUTES_ENV = 'staging';
      expect(spendGuard.dailyCapAUD()).toBe(20);
      process.env.ALGOMINUTES_ENV = 'prod';
      expect(spendGuard.dailyCapAUD()).toBe(200);
    } finally {
      if (saved.a === undefined) delete process.env.ALGOMINUTES_ENV; else process.env.ALGOMINUTES_ENV = saved.a;
      process.env.NODE_ENV = saved.n;
    }
  });
});
