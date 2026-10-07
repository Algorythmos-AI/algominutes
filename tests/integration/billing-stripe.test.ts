import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';

// The web billing rail against the Stripe SDK, end to end except the network:
// a local stand-in for api.stripe.com records what the SDK sends and answers
// with API-shaped objects. It pins what a Stripe SDK major could change: the
// requests (paths, form fields, the pinned Stripe-Version), the shapes our
// handlers read back, and webhook signature checking. Real Postgres.
type Seen = { method: string; path: string; version: string | undefined; form: URLSearchParams; key?: string };
const seen: Seen[] = [];
const PERIOD_END = 1_790_000_000;

// What Stripe says each subscription is now; a test changes it to play a renewal, arrears or a cancellation.
const SUB_1 = () => ({
  id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', current_period_end: PERIOD_END as number | undefined,
  items: { object: 'list', data: [{ id: 'si_1', object: 'subscription_item', price: { id: 'price_test_pro', object: 'price' } } as Record<string, unknown>] },
});
const stripeSubs: Record<string, ReturnType<typeof SUB_1>> = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url || '').split('?')[0];
    seen.push({ method: req.method || '', path, version: req.headers['stripe-version'] as string | undefined, form: new URLSearchParams(body), key: req.headers['idempotency-key'] as string | undefined });
    const reply = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && path === '/v1/billing_portal/sessions') return reply(200, { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.test/p/session/1' });
    if (req.method === 'POST' && path === '/v1/checkout/sessions') return reply(200, { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.test/c/pay/cs_1' });
    const subId = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path)?.[1];
    if (req.method === 'GET' && subId && stripeSubs[subId]) return reply(200, stripeSubs[subId]);
    return reply(404, { error: { type: 'invalid_request_error', message: `no route ${req.method} ${path}` } });
  });
});

let billing: any;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_PRO_MONTHLY: 'price_test_pro',
    STRIPE_API_HOST: '127.0.0.1',
    STRIPE_API_PORT: String(port),
    STRIPE_API_PROTOCOL: 'http',
  });
  billing = {
    stripe: await import('../../services/billing/src/lib/stripe.js'),
    portal: await import('../../services/billing/src/routes/portal.js'),
    checkout: await import('../../services/billing/src/routes/checkout.js'),
    webhook: await import('../../services/billing/src/webhooks/stripe.js'),
  };
});
beforeEach(async () => {
  seen.length = 0;
  for (const k of Object.keys(stripeSubs)) delete stripeSubs[k];
  stripeSubs.sub_1 = SUB_1();
  await resetDb();
  await seedUser('u1');
});
afterAll(async () => {
  server.close();
  await pool.end();
  await getPool().end();
});

const noop = () => {};
const log: any = { info: noop, warn: noop, error: noop, child: () => log };
function call(route: (req: any, res: any) => Promise<unknown>, req: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    let status = 200;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (body: any) => { resolve({ status, body }); return res; } };
    route({ log, ...req }, res).catch(reject);
  });
}
const sub = async () => (await pool.query(
  `SELECT plan, status, source, stripe_subscription_id, stripe_customer_id, current_period_end FROM subscriptions WHERE uid = 'u1'`,
)).rows[0];

function signed(event: unknown) {
  const payload = JSON.stringify(event);
  const header = billing.stripe.getStripe().webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  return { body: Buffer.from(payload), headers: { 'stripe-signature': header } };
}
const checkoutCompleted = {
  id: 'evt_1', object: 'event', type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', object: 'checkout.session', client_reference_id: 'u1', subscription: 'sub_1', customer: 'cus_1', metadata: { uid: 'u1' } } },
};

describe('Stripe: checkout and the portal', () => {
  it('checkout sends the subscription session our webhook resolves, with the pinned API version', async () => {
    const r = await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } });
    expect(r).toEqual({ status: 200, body: { url: 'https://checkout.stripe.test/c/pay/cs_1' } });
    const [req] = seen;
    expect([req.method, req.path, req.version]).toEqual(['POST', '/v1/checkout/sessions', '2024-06-20']);
    expect(Object.fromEntries(req.form)).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_test_pro',
      'line_items[0][quantity]': '1',
      client_reference_id: 'u1',
      'metadata[uid]': 'u1',
      'subscription_data[metadata][plan]': 'pro',
    });
  });

  // RELEASE.md PR 26b, the pre-purchase check: a second store charge can't be refunded from here, so it must
  // never start.
  it('refuses a second subscription to anyone already paying, on any rail, and says which', async () => {
    const paying = (source: string, extra: string) => pool.query(
      `INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, ${extra})
       VALUES ('u1', 'pro', 'active', 'active', $1, NOW() + INTERVAL '20 days', $2)
       ON CONFLICT (uid) DO UPDATE SET source = EXCLUDED.source, current_period_end = EXCLUDED.current_period_end`,
      [source, source === 'stripe' ? 'sub_1' : '2000000000000001'],
    );
    await paying('apple_storekit', 'apple_original_transaction_id');
    expect(await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } }))
      .toEqual({ status: 409, body: { error: 'Already subscribed', rail: 'apple_storekit' } });
    await pool.query(`DELETE FROM subscriptions WHERE uid = 'u1'`);
    await paying('stripe', 'stripe_subscription_id');
    expect(await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } }))
      .toEqual({ status: 409, body: { error: 'Already subscribed', rail: 'stripe' } });
    expect(seen).toEqual([]); // Stripe never asked
  });

  it('lets a lapsed subscriber, a trial or a grant buy', async () => {
    await pool.query(
      `INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, apple_original_transaction_id)
       VALUES ('u1', 'pro', 'expired', 'free_floor', 'apple_storekit', NOW() - INTERVAL '2 days', '2000000000000001')`,
    );
    expect((await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } })).status).toBe(200);
    await pool.query(`UPDATE subscriptions SET status = 'trialing', entitlement_state = 'trialing', source = NULL, current_period_end = NULL,
      apple_original_transaction_id = NULL, trial_started_at = NOW(), trial_end = NOW() + INTERVAL '5 days' WHERE uid = 'u1'`);
    expect((await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } })).status).toBe(200);
    await pool.query(`INSERT INTO entitlement_grants (uid, plan, reason) VALUES ('u1', 'pro', 'invite:1')`);
    expect((await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } })).status).toBe(200);
  });

  // RELEASE.md PR 28: Stripe sends the buyer back to the web app they came from, only on an origin we serve.
  it('returns the buyer to the web app they came from, when its origin is one we serve', async () => {
    const saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://beta.example.test,http://plain.example.test';
    try {
      const urls = async (origin?: string) => {
        seen.length = 0;
        await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' }, headers: origin ? { origin } : {} });
        return [seen[0].form.get('success_url'), seen[0].form.get('cancel_url')];
      };
      expect(await urls('https://beta.example.test')).toEqual(['https://beta.example.test/app/billing/success', 'https://beta.example.test/app/billing/cancel']);
      const site = await urls();
      expect(site[0]).toMatch(/\/billing\/success$/);
      expect(site[0]).not.toContain('beta.example.test');
      // Not on the allowlist, not https, or not just an origin: the public site, never that host.
      for (const origin of ['https://evil.example.test', 'http://plain.example.test', 'https://beta.example.test/x', 'https://user@beta.example.test', 'capacitor://localhost']) {
        const [success, cancel] = await urls(origin);
        expect(success, origin).toEqual(site[0]);
        expect(cancel, origin).toEqual(site[1]);
      }
      await pool.query(`INSERT INTO subscriptions (uid, plan, status, stripe_customer_id) VALUES ('u1', 'pro', 'expired', 'cus_1')`);
      seen.length = 0;
      await call(billing.portal.portalRoute, { uid: 'u1', headers: { origin: 'https://beta.example.test' } });
      expect(seen[0].form.get('return_url')).toBe('https://beta.example.test/app/settings');
      seen.length = 0;
      await call(billing.portal.portalRoute, { uid: 'u1', headers: { origin: 'https://evil.example.test' } });
      expect(seen[0].form.get('return_url')).not.toContain('evil');
    } finally {
      if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = saved;
    }
  });

  it("the portal opens a session for the account's customer, and answers 409 without one", async () => {
    expect(await call(billing.portal.portalRoute, { uid: 'u1' })).toEqual({ status: 409, body: { error: 'No Stripe customer for this account' } });
    expect(seen).toEqual([]);
    await pool.query(`INSERT INTO subscriptions (uid, plan, status, stripe_customer_id) VALUES ('u1', 'pro', 'active', 'cus_1')`);
    expect(await call(billing.portal.portalRoute, { uid: 'u1' })).toEqual({ status: 200, body: { url: 'https://billing.stripe.test/p/session/1' } });
    expect([seen[0].path, seen[0].form.get('customer'), seen[0].version]).toEqual(['/v1/billing_portal/sessions', 'cus_1', '2024-06-20']);
  });
});

describe('Stripe: the webhook', () => {
  it('a signed checkout completion reads the subscription back and activates Pro until its period end', async () => {
    const r = await call(billing.webhook.stripeWebhookRoute, signed(checkoutCompleted));
    expect(r.status).toBe(200);
    expect(seen.map((s) => [s.method, s.path, s.version])).toEqual([['GET', '/v1/subscriptions/sub_1', '2024-06-20']]);
    expect(await sub()).toMatchObject({
      plan: 'pro', status: 'active', source: 'stripe', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1',
      current_period_end: new Date(PERIOD_END * 1000),
    });
  });

  it('a renewal (invoice.paid) finds the account by its subscription and extends it', async () => {
    await call(billing.webhook.stripeWebhookRoute, signed(checkoutCompleted));
    await pool.query(`UPDATE subscriptions SET current_period_end = NOW() WHERE uid = 'u1'`);
    const renewal = { id: 'evt_2', object: 'event', type: 'invoice.paid', data: { object: { id: 'in_1', object: 'invoice', subscription: 'sub_1', customer: 'cus_1' } } };
    expect((await call(billing.webhook.stripeWebhookRoute, signed(renewal))).status).toBe(200);
    expect((await sub()).current_period_end).toEqual(new Date(PERIOD_END * 1000));
  });

  it('a payload that does not match its signature is refused (400) and changes nothing', async () => {
    const good = signed(checkoutCompleted);
    const forged = { ...good, body: Buffer.from(JSON.stringify({ ...checkoutCompleted, id: 'evt_forged' })) };
    expect((await call(billing.webhook.stripeWebhookRoute, forged)).status).toBe(400);
    expect(await sub()).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

// RELEASE.md rev 11, H21: any refund took Pro away at once, a partial one (a goodwill credit, a prorated
// plan change) included, and a replayed event moved the end of the period each time.
describe('Stripe: refunds', () => {
  const refund = (id: string, charge: Record<string, unknown>) => ({
    id, object: 'event', type: 'charge.refunded',
    data: { object: { id: 'ch_1', object: 'charge', customer: 'cus_1', amount: 2900, ...charge } },
  });
  const cancellations = async () => Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM analytics_events WHERE uid = 'u1' AND event = 'cancellation'`,
  )).rows[0].n);

  it('a partial refund keeps Pro, to the same period end', async () => {
    await call(billing.webhook.stripeWebhookRoute, signed(checkoutCompleted));
    const r = await call(billing.webhook.stripeWebhookRoute, signed(refund('evt_r1', { amount_refunded: 500, refunded: false })));
    expect(r.status).toBe(200);
    expect(await sub()).toMatchObject({ status: 'active', current_period_end: new Date(PERIOD_END * 1000) });
    expect(await cancellations()).toBe(0);
  });

  it('a full refund ends Pro now; the same event again changes nothing more', async () => {
    await call(billing.webhook.stripeWebhookRoute, signed(checkoutCompleted));
    const full = refund('evt_r2', { amount_refunded: 2900, refunded: true });
    expect((await call(billing.webhook.stripeWebhookRoute, signed(full))).status).toBe(200);
    const first = await sub();
    expect(first.status).toBe('refunded');
    expect(Math.abs(first.current_period_end.getTime() - Date.now())).toBeLessThan(10_000);
    // Stripe delivers at least once: a replay must not move the end again, or count a second cancellation.
    await pool.query(`UPDATE subscriptions SET current_period_end = current_period_end - INTERVAL '1 hour' WHERE uid = 'u1'`);
    const moved = (await sub()).current_period_end;
    expect((await call(billing.webhook.stripeWebhookRoute, signed(full))).status).toBe(200);
    expect((await sub()).current_period_end).toEqual(moved);
    expect(await cancellations()).toBe(1);
  });

  it('refunded in parts until nothing is left: Pro ends with the last part', async () => {
    await call(billing.webhook.stripeWebhookRoute, signed(checkoutCompleted));
    await call(billing.webhook.stripeWebhookRoute, signed(refund('evt_r3', { amount_refunded: 1000, refunded: false })));
    expect((await sub()).status).toBe('active');
    await call(billing.webhook.stripeWebhookRoute, signed(refund('evt_r4', { amount_refunded: 2900 })));
    expect((await sub()).status).toBe('refunded');
  });
});

// RELEASE.md rev 11, H21: events arrive late, twice and out of order. Four handlers wrote what the event
// said; they now read the subscription back and write what Stripe says it is.
describe('Stripe: an event is a reason to look, not the state', () => {
  const event = (id: string, type: string, object: Record<string, unknown>) => ({ id, object: 'event', type, data: { object } });
  const send = (e: unknown) => call(billing.webhook.stripeWebhookRoute, signed(e));
  const cancellations = async () => Number((await pool.query(
    `SELECT COUNT(*)::int AS n FROM analytics_events WHERE uid = 'u1' AND event = 'cancellation'`,
  )).rows[0].n);
  beforeEach(async () => { await send(checkoutCompleted); });

  it('a failed payment from before a renewal, delivered after it, leaves the paid account active', async () => {
    const r = await send(event('evt_o1', 'invoice.payment_failed', { id: 'in_old', object: 'invoice', subscription: 'sub_1', customer: 'cus_1' }));
    expect(r.status).toBe(200);
    expect(await sub()).toMatchObject({ status: 'active', current_period_end: new Date(PERIOD_END * 1000) });
  });

  it('a failed payment while Stripe says past due is past due, with the paid period kept', async () => {
    stripeSubs.sub_1.status = 'past_due';
    await send(event('evt_o2', 'invoice.payment_failed', { id: 'in_2', object: 'invoice', subscription: 'sub_1', customer: 'cus_1' }));
    expect(await sub()).toMatchObject({ status: 'past_due', current_period_end: new Date(PERIOD_END * 1000) });
  });

  it("an old \"canceled\" update, replayed after the subscription was resumed, doesn't cancel it", async () => {
    await send(event('evt_o3', 'customer.subscription.updated', { ...SUB_1(), status: 'canceled' }));
    expect((await sub()).status).toBe('active');
  });

  it('a cancellation is written once, keeps the paid period, and counts once however often it is delivered', async () => {
    stripeSubs.sub_1.status = 'canceled';
    const deleted = event('evt_o4', 'customer.subscription.deleted', { ...SUB_1(), status: 'canceled' });
    await send(deleted);
    await send(deleted);
    expect(await sub()).toMatchObject({ status: 'canceled', current_period_end: new Date(PERIOD_END * 1000) });
    expect(await cancellations()).toBe(1);
  });

  it("another subscription of the same customer ending doesn't touch the one the account is on", async () => {
    stripeSubs.sub_2 = { ...SUB_1(), id: 'sub_2', status: 'canceled' };
    const r = await send(event('evt_o5', 'customer.subscription.deleted', { ...SUB_1(), id: 'sub_2', status: 'canceled' }));
    expect(r.status).toBe(200);
    expect(await sub()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_1' });
    expect(await cancellations()).toBe(0);
  });

  it("Stripe can't be asked: a failed payment is past due, and an update is taken as it came", async () => {
    delete stripeSubs.sub_1;
    await send(event('evt_o6', 'invoice.payment_failed', { id: 'in_3', object: 'invoice', subscription: 'sub_1', customer: 'cus_1' }));
    expect((await sub()).status).toBe('past_due');
    await send(event('evt_o7', 'customer.subscription.updated', { ...SUB_1(), status: 'active' }));
    expect((await sub()).status).toBe('active');
  });

  it("reads the newer API's shape: the period end on the item, the invoice's subscription under parent", async () => {
    const later = PERIOD_END + 30 * 86400;
    stripeSubs.sub_1.current_period_end = undefined;
    stripeSubs.sub_1.items.data[0].current_period_end = later;
    const renewal = event('evt_o8', 'invoice.paid', {
      id: 'in_4', object: 'invoice', customer: 'cus_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } },
    });
    expect((await send(renewal)).status).toBe(200);
    expect((await sub()).current_period_end).toEqual(new Date(later * 1000));
  });
});

// RELEASE.md rev 11, H21: two checkouts open at once both passed the pre-purchase check, and the second
// completion replaced the first on the row, leaving the first charging with nothing pointing at it.
describe('Stripe: one subscription per account', () => {
  const send = (e: unknown) => call(billing.webhook.stripeWebhookRoute, signed(e));
  const completed = (id: string, subscription: string) => ({
    ...checkoutCompleted, id, data: { object: { ...checkoutCompleted.data.object, id: `cs_${subscription}`, subscription } },
  });
  const queued = async () => (await pool.query(`SELECT stripe_subscription_id FROM stripe_cancellations ORDER BY 1`)).rows.map((r) => r.stripe_subscription_id);
  // A period that is still running: the file's PERIOD_END is a fixed date, and by now a past one.
  const RUNNING = Math.floor(Date.now() / 1000) + 20 * 86400;
  beforeEach(() => { stripeSubs.sub_1.current_period_end = RUNNING; });

  it('the same buyer asking twice gets the same idempotency key; another buyer, price or window gets another', async () => {
    await seedUser('u2');
    await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } });
    await call(billing.checkout.checkoutRoute, { uid: 'u1', body: { productId: 'pro_monthly' } });
    await call(billing.checkout.checkoutRoute, { uid: 'u2', body: { productId: 'pro_monthly' } });
    const keys = seen.filter((r) => r.path === '/v1/checkout/sessions').map((r) => r.key);
    expect(keys[0]).toMatch(/^checkout_[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.join()).not.toContain('u1');

    const { checkoutIdempotencyKey } = billing.checkout;
    const base = { uid: 'u1', priceId: 'price_a', successUrl: 'https://a/s', cancelUrl: 'https://a/c', customerId: null };
    const at = 1_800_000_000_000;
    expect(checkoutIdempotencyKey(base, at + 60_000)).toBe(checkoutIdempotencyKey(base, at));
    expect(checkoutIdempotencyKey(base, at + 11 * 60_000)).not.toBe(checkoutIdempotencyKey(base, at));
    expect(checkoutIdempotencyKey({ ...base, priceId: 'price_b' }, at)).not.toBe(checkoutIdempotencyKey(base, at));
    expect(checkoutIdempotencyKey({ ...base, successUrl: 'https://b/s' }, at)).not.toBe(checkoutIdempotencyKey(base, at));
  });

  it('a second subscription completing for a paying account is queued for cancellation, and the first stands', async () => {
    stripeSubs.sub_2 = { ...SUB_1(), id: 'sub_2', current_period_end: RUNNING };
    await send(completed('evt_d1', 'sub_1'));
    seen.length = 0;
    const r = await send(completed('evt_d2', 'sub_2'));
    expect(r.status).toBe(200);
    expect(await sub()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_1' });
    expect(await queued()).toEqual(['sub_2']);
    expect(seen).toEqual([]); // the duplicate is never read or activated
    // Delivered again: still one row in the queue, still the first subscription.
    await send(completed('evt_d2', 'sub_2'));
    expect(await queued()).toEqual(['sub_2']);
    expect((await sub()).stripe_subscription_id).toBe('sub_1');
  });

  it("the account's own completion delivered again is not a duplicate", async () => {
    await send(completed('evt_d3', 'sub_1'));
    await send(completed('evt_d3', 'sub_1'));
    expect(await queued()).toEqual([]);
    expect(await sub()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_1' });
  });

  it('paying through the App Store already: the Stripe subscription is the duplicate', async () => {
    await pool.query(
      `INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, apple_original_transaction_id)
       VALUES ('u1', 'pro', 'active', 'active', 'apple_storekit', NOW() + INTERVAL '20 days', '2000000000000001')`,
    );
    await send(completed('evt_d4', 'sub_1'));
    expect(await queued()).toEqual(['sub_1']);
    expect(await sub()).toMatchObject({ source: 'apple_storekit', stripe_subscription_id: null });
  });

  it('a lapsed subscriber buying again is activated on the new subscription', async () => {
    stripeSubs.sub_2 = { ...SUB_1(), id: 'sub_2', current_period_end: RUNNING };
    await send(completed('evt_d5', 'sub_1'));
    await pool.query(`UPDATE subscriptions SET current_period_end = NOW() - INTERVAL '1 day', status = 'canceled' WHERE uid = 'u1'`);
    await send(completed('evt_d6', 'sub_2'));
    expect(await queued()).toEqual([]);
    expect(await sub()).toMatchObject({ status: 'active', stripe_subscription_id: 'sub_2' });
  });
});
