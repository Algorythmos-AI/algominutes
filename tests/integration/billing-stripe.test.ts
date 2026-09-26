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
type Seen = { method: string; path: string; version: string | undefined; form: URLSearchParams };
const seen: Seen[] = [];
const PERIOD_END = 1_790_000_000;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url || '').split('?')[0];
    seen.push({ method: req.method || '', path, version: req.headers['stripe-version'] as string | undefined, form: new URLSearchParams(body) });
    const reply = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && path === '/v1/billing_portal/sessions') return reply(200, { id: 'bps_1', object: 'billing_portal.session', url: 'https://billing.stripe.test/p/session/1' });
    if (req.method === 'POST' && path === '/v1/checkout/sessions') return reply(200, { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.test/c/pay/cs_1' });
    if (req.method === 'GET' && path === '/v1/subscriptions/sub_1') {
      return reply(200, {
        id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', current_period_end: PERIOD_END,
        items: { object: 'list', data: [{ id: 'si_1', object: 'subscription_item', price: { id: 'price_test_pro', object: 'price' } }] },
      });
    }
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
