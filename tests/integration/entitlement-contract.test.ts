import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getPool, resolveEntitlement, grantEntitlement } from '@algominutes/db';
import { EntitlementResponse } from '@algominutes/contracts/schemas';
// @ts-expect-error: plain ESM route module, no type declarations
import { toEntitlementResponse } from '../../services/api/src/routes/entitlement.js';
import { pool, resetDb, seedUser } from './helpers';

// GET /v1/entitlement (and /v1/process's 402 body) must satisfy the published
// EntitlementResponse contract that the iOS/Android/web paywalls are generated
// from. It didn't: `state` (required) and `trialEndsAt` were dropped by the
// shaper, so every live body failed EntitlementResponse.parse.
beforeEach(async () => {
  await resetDb();
  await seedUser('u1');
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

const body = async () => toEntitlementResponse(await resolveEntitlement('u1'));
const sub = (overrides: Record<string, unknown>) => {
  const cols = { uid: 'u1', plan: 'pro', status: 'trialing', entitlement_state: 'trialing', ...overrides };
  const keys = Object.keys(cols);
  const vals = Object.values(cols);
  return pool.query(
    `INSERT INTO subscriptions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
};

describe('entitlement response satisfies the published contract', () => {
  it('brand-new caller (no subscription row): trialing, no end yet', async () => {
    const b = await body();
    expect(() => EntitlementResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({ state: 'trialing', trialEndsAt: null });
  });

  it('in a reverse trial: trialing, with its end date', async () => {
    const end = new Date(Date.now() + 5 * 86_400_000);
    await sub({ trial_started_at: new Date(), trial_end: end });
    const b = await body();
    expect(() => EntitlementResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({ state: 'trialing', plan: 'pro', trialEndsAt: end.toISOString() });
  });

  it('paid: active, no trial end', async () => {
    await sub({ status: 'active', entitlement_state: 'active', current_period_end: new Date(Date.now() + 20 * 86_400_000), stripe_subscription_id: 'sub_1' });
    const b = await body();
    expect(() => EntitlementResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({ state: 'active', trialEndsAt: null });
  });

  it('trial over, never paid: free floor', async () => {
    await sub({ trial_started_at: new Date(Date.now() - 10 * 86_400_000), trial_end: new Date(Date.now() - 3 * 86_400_000) });
    const b = await body();
    expect(() => EntitlementResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({ state: 'free_floor', plan: 'free', trialEndsAt: null });
  });
});

// RELEASE.md PR 26b: where an entitlement comes from. A grant reports `active` like a subscription, so the
// clients key the purchase funnel and "Manage Subscription" off `source`, and manage one on its `rail`.
describe('the entitlement says where it comes from', () => {
  const future = () => new Date(Date.now() + 20 * 86_400_000);
  const check = async (expected: Record<string, unknown>) => {
    const b = await body();
    expect(() => EntitlementResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject(expected);
  };

  it('the trial, and the free floor after it', async () => {
    await check({ state: 'trialing', source: 'trial', rail: null });
    await sub({ trial_started_at: new Date(Date.now() - 10 * 86_400_000), trial_end: new Date(Date.now() - 3 * 86_400_000) });
    await check({ state: 'free_floor', source: 'free', rail: null });
  });

  it('a subscription, with the store it is billed on', async () => {
    await sub({ status: 'active', entitlement_state: 'active', source: 'apple_storekit', current_period_end: future(), apple_original_transaction_id: '2000000000000001' });
    await check({ state: 'active', plan: 'pro', source: 'subscription', rail: 'apple_storekit' });
    await pool.query(`UPDATE subscriptions SET source = 'stripe', stripe_subscription_id = 'sub_1' WHERE uid = 'u1'`);
    await check({ source: 'subscription', rail: 'stripe' });
    // A rail this build doesn't know is no rail, never a wrong one.
    await pool.query(`UPDATE subscriptions SET source = 'something_new' WHERE uid = 'u1'`);
    await check({ source: 'subscription', rail: null });
  });

  it('a grant: active like a subscription, but not one', async () => {
    await sub({ trial_started_at: new Date(Date.now() - 10 * 86_400_000), trial_end: new Date(Date.now() - 3 * 86_400_000) });
    await grantEntitlement({ uid: 'u1', plan: 'pro', reason: 'invite:1' });
    await check({ state: 'active', plan: 'pro', source: 'grant', rail: null });
  });

  it('a paid subscription wins over a grant', async () => {
    await sub({ status: 'active', entitlement_state: 'active', source: 'stripe', current_period_end: future(), stripe_subscription_id: 'sub_1' });
    await grantEntitlement({ uid: 'u1', plan: 'pro', reason: 'invite:1' });
    await check({ state: 'active', source: 'subscription', rail: 'stripe' });
  });
});
