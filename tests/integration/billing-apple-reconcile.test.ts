import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getPool, listAppleSubscriptionsDue, recordAppleCheck, setSubscriptionStatus, activateSubscription,
  deriveState, getSubscription, trackEvent,
} from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';
// @ts-expect-error: plain ESM module, no type declarations
import { createReconcileApple } from '../../services/billing/src/tasks/reconcile-apple.js';

// RELEASE.md PR 26: which App Store subscriptions billing asks Apple about, and how Apple's answer is
// written without undoing a notification or purchase that wrote the row meanwhile. Real Postgres.

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await pool.end();
  await getPool().end();
});

/** An App Store subscriber whose period ends `endsIn` from now, last checked `checked` ago (null: never). */
async function subscriber(uid: string, { endsIn, checked = null, source = 'apple_storekit', otid = `2000${uid.replace(/\D/g, '') || '9'}` }: { endsIn: string; checked?: string | null; source?: string; otid?: string | null }) {
  await seedUser(uid);
  await pool.query(
    `INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, apple_original_transaction_id, apple_checked_at, updated_at)
     VALUES ($1, 'pro', 'active', 'active', $2, NOW() + $3::interval, $4, NOW() - $5::interval, NOW() - INTERVAL '1 day')`,
    [uid, source, endsIn, otid, checked],
  );
}
const row = async (uid: string) => (await pool.query(
  `SELECT status, plan, current_period_end, apple_checked_at, updated_at, entitlement_state FROM subscriptions WHERE uid = $1`, [uid],
)).rows[0];

describe('the subscriptions due a check with Apple', () => {
  it('are those near the end of their period, then any not checked for a week, and only Apple’s', async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });   // a renewal whose notification may be lost
    await subscriber('u2', { endsIn: '12 hours', checked: null });        // about to renew, never checked
    await subscriber('u3', { endsIn: '20 days', checked: '8 days' });     // mid-period: a refund could be missed
    await subscriber('u4', { endsIn: '20 days', checked: null });         // new, never checked
    await subscriber('u5', { endsIn: '-2 hours', checked: '1 hour' });    // near the end, but just checked
    await subscriber('u6', { endsIn: '20 days', checked: '2 days' });     // mid-period, checked this week
    await subscriber('u7', { endsIn: '-40 days', checked: null });        // lapsed long ago
    await subscriber('u8', { endsIn: '-2 hours', checked: null, source: 'stripe' }); // moved to Stripe, kept its Apple id
    await subscriber('u9', { endsIn: '-2 hours', checked: null, otid: null });        // never Apple's
    await subscriber('u10', { endsIn: '-5 days', checked: '9 days' });   // past the near window: weekly, and checked longest ago

    const due = await listAppleSubscriptionsDue(100);
    expect(due.map((d) => d.uid)).toEqual(['u2', 'u1', 'u4', 'u10', 'u3']);
    expect(due[1]).toMatchObject({ uid: 'u1', originalTransactionId: '20001', status: 'active', plan: 'pro', currentPeriodEnd: expect.stringMatching(/Z$/), version: expect.stringMatching(/^\d+$/) });
    expect((await listAppleSubscriptionsDue(2)).map((d) => d.uid)).toEqual(['u2', 'u1']);
  });
});

describe("Apple's answer, recorded", () => {
  it('writes the change and stamps the check; the row is then not due', async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });
    const [due] = await listAppleSubscriptionsDue();
    const end = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(await recordAppleCheck(due, { status: 'active', currentPeriodEnd: end, plan: 'pro' })).toBe('updated');
    const r = await row('u1');
    expect(r.current_period_end.toISOString()).toBe(end);
    expect(Date.now() - r.apple_checked_at.getTime()).toBeLessThan(60_000);
    expect(Date.now() - r.updated_at.getTime()).toBeLessThan(60_000);
    expect(deriveState(await getSubscription('u1'))).toBe('active');
    expect(await listAppleSubscriptionsDue()).toEqual([]);
  });

  it('with nothing to change, stamps only the check', async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });
    const before = await row('u1');
    const [due] = await listAppleSubscriptionsDue();
    expect(await recordAppleCheck(due, null)).toBe('checked');
    const after = await row('u1');
    expect(after.updated_at).toEqual(before.updated_at);
    expect(after.current_period_end).toEqual(before.current_period_end);
    expect(after.apple_checked_at.getTime()).toBeGreaterThan(before.apple_checked_at.getTime());
  });

  it('never undoes a notification that wrote the row after it was read', async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });
    const [due] = await listAppleSubscriptionsDue();
    // Apple's REFUND notification lands while the reconcile is asking: the answer it gets is older.
    await setSubscriptionStatus('u1', 'refunded', new Date().toISOString());
    const refunded = await row('u1');
    expect(await recordAppleCheck(due, { status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(), plan: 'pro' })).toBe('raced');
    expect(await row('u1')).toEqual(refunded);
  });

  it("never writes Apple's answer over a subscription that moved to another rail", async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });
    const [due] = await listAppleSubscriptionsDue();
    await activateSubscription({ uid: 'u1', rail: 'stripe', plan: 'pro', currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(), stripeSubscriptionId: 'sub_1' });
    const stripe = await row('u1');
    // Even were the version unchanged, the source check holds: forge the version the row has now.
    const { rows } = await pool.query(`SELECT xmin::text AS version FROM subscriptions WHERE uid = 'u1'`);
    expect(await recordAppleCheck({ ...due, version: rows[0].version }, { status: 'expired', currentPeriodEnd: new Date().toISOString(), plan: 'pro' })).toBe('raced');
    expect(await row('u1')).toEqual(stripe);
  });
});

describe('the reconcile, end to end on Postgres', () => {
  it("restores a subscriber whose renewal notification was lost, and ends one whose refund was, once each", async () => {
    await subscriber('u1', { endsIn: '-2 hours', checked: '7 hours' });
    await subscriber('u2', { endsIn: '20 days', checked: '8 days' });
    expect(deriveState(await getSubscription('u1'))).toBe('free_floor'); // cut off by the lost DID_RENEW
    const renewedTo = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const apple: Record<string, unknown> = {
      20001: { environment: 'Production', status: 'active', productId: 'pro_monthly', currentPeriodEnd: renewedTo, revoked: false, graceEnd: null },
      20002: { environment: 'Production', status: 'revoked', productId: 'pro_monthly', currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000).toISOString(), revoked: true, graceEnd: null },
    };
    let asked = 0;
    const route = createReconcileApple({
      appStoreServer: async () => ({ client: { subscriptionStatus: async (id: string) => { asked += 1; return apple[id]; } } }),
      repo: { listAppleSubscriptionsDue, recordAppleCheck, trackEvent },
    });
    const noop = () => {};
    const log: any = { info: noop, warn: noop, error: noop, child: () => log };
    const run = async () => {
      const out = { status: 0, body: undefined as any };
      await route({ log }, { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } });
      return out;
    };
    expect(await run()).toMatchObject({ status: 200, body: { due: 2, updated: 2, failed: 0 } });
    expect(deriveState(await getSubscription('u1'))).toBe('active');
    expect((await row('u1')).current_period_end.toISOString()).toBe(renewedTo);
    expect(deriveState(await getSubscription('u2'))).toBe('free_floor');
    expect((await row('u2')).status).toBe('refunded');
    const events = await pool.query(`SELECT uid, event, props FROM analytics_events WHERE event = 'cancellation'`);
    expect(events.rows).toEqual([{ uid: 'u2', event: 'cancellation', props: { rail: 'apple_storekit', reason: 'reconcile_refunded' } }]);
    // Replayed (Cloud Scheduler fires twice, or a person runs it): nothing is due, Apple isn't asked again.
    expect(await run()).toMatchObject({ status: 200, body: { due: 0 } });
    expect(asked).toBe(2);
  });
});
