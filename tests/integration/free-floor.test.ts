import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { getPool, resolveEntitlement, assertCanMeter, configuredFreeFloorMinutes } from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';

// The free floor per environment (plan rev 12, Stage 3; owner decision 1: 120 minutes for every new account in
// 1.0, so a reviewer and every new user can record before buying). It was a constant in the contracts (unset, so
// 0 everywhere); now FREE_FLOOR_MINUTES sets it where it's wanted (prod), and staging's beta keeps 0, where an
// invite code is how a guest gets minutes and the nightly's held-first case relies on that.
const saved = { floor: process.env.FREE_FLOOR_MINUTES, trial: process.env.TRIAL_ON_FIRST_USE };
beforeEach(async () => {
  await resetDb();
  process.env.TRIAL_ON_FIRST_USE = 'off';
  delete process.env.FREE_FLOOR_MINUTES;
});
afterEach(() => {
  for (const [k, v] of [['FREE_FLOOR_MINUTES', saved.floor], ['TRIAL_ON_FIRST_USE', saved.trial]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

describe('the free floor', () => {
  it('unset, is 0: nothing metered runs without a trial, a grant or a plan (fail safe)', async () => {
    await seedUser('u1');
    expect(await resolveEntitlement('u1')).toMatchObject({ state: 'free_floor', plan: 'free', includedMinutes: 0, overQuota: true });
    await expect(assertCanMeter('u1', 1)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('set, gives every new account its minutes, and a recording within them may run', async () => {
    process.env.FREE_FLOOR_MINUTES = '120';
    await seedUser('u1');
    expect(await resolveEntitlement('u1')).toMatchObject({ state: 'free_floor', plan: 'free', includedMinutes: 120, remainingMinutes: 120, overQuota: false });
    await expect(assertCanMeter('u1', 60)).resolves.toMatchObject({ includedMinutes: 120 });
    await expect(assertCanMeter('u1', 121)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('is where an ended trial lands, too', async () => {
    process.env.FREE_FLOOR_MINUTES = '120';
    await seedUser('u2');
    await pool.query(
      `INSERT INTO subscriptions (uid, plan, status, entitlement_state, trial_end) VALUES ('u2', 'pro', 'trialing', 'trialing', NOW() - INTERVAL '1 day')`,
    );
    expect(await resolveEntitlement('u2')).toMatchObject({ state: 'free_floor', includedMinutes: 120 });
  });

  it('anything but a whole number from 0 to 1,000 is 0, never a guess', () => {
    expect(configuredFreeFloorMinutes({ FREE_FLOOR_MINUTES: '120' })).toBe(120);
    expect(configuredFreeFloorMinutes({ FREE_FLOOR_MINUTES: ' 0 ' })).toBe(0);
    expect(configuredFreeFloorMinutes({ FREE_FLOOR_MINUTES: '1000' })).toBe(1000);
    for (const bad of [undefined, '', 'abc', '-5', '1.5', '1001', '1e3', 'Infinity']) {
      expect(configuredFreeFloorMinutes({ FREE_FLOOR_MINUTES: bad }), String(bad)).toBe(0);
    }
  });
});
