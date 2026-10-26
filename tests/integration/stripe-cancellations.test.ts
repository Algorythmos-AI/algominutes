import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPool, deleteAccountData, listDueStripeCancellations, markStripeCancelled, markStripeCancelFailed, STRIPE_CANCEL_STUCK_ATTEMPTS } from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';

// RELEASE.md PR 28b: a deleted account's Stripe subscription is cancelled with Stripe, never left charging.
// The deletion records it; a checkout webhook arriving after the deletion records its one instead of
// activating; billing's cancel-stripe task cancels each, against a local stand-in for api.stripe.com.

type StubSub = { status: number; body: unknown };
const subs = new Map<string, StubSub>();
const seen: Array<{ method: string; path: string; form: URLSearchParams }> = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const [path, query = ''] = (req.url || '').split('?');
    // The SDK sends a DELETE's parameters in the query string, a POST's in the body.
    seen.push({ method: req.method || '', path, form: new URLSearchParams(body || query) });
    const reply = (status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
    if (m) {
      const s = subs.get(m[1]);
      if (!s) return reply(404, { error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such subscription: '${m[1]}'` } });
      if (req.method === 'DELETE' && s.status === 200) {
        subs.set(m[1], { status: 200, body: { ...(s.body as object), status: 'canceled' } });
        return reply(200, { id: m[1], object: 'subscription', status: 'canceled' });
      }
      return reply(s.status, s.body);
    }
    return reply(404, { error: { type: 'invalid_request_error', message: `no route ${req.method} ${path}` } });
  });
});
const active = (id: string): StubSub => ({ status: 200, body: { id, object: 'subscription', status: 'active', items: { object: 'list', data: [] } } });

let billing: any;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  Object.assign(process.env, {
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_API_HOST: '127.0.0.1',
    STRIPE_API_PORT: String(port),
    STRIPE_API_PROTOCOL: 'http',
  });
  billing = {
    stripe: await import('../../services/billing/src/lib/stripe.js'),
    webhook: await import('../../services/billing/src/webhooks/stripe.js'),
    task: await import('../../services/billing/src/tasks/cancel-stripe.js'),
  };
});
beforeEach(async () => {
  subs.clear();
  seen.length = 0;
  await resetDb();
});
afterAll(async () => {
  server.close();
  await pool.end();
  await getPool().end();
});

type Line = { level: string; o: Record<string, any>; msg: string };
function logger() {
  const lines: Line[] = [];
  const make = (ctx: Record<string, unknown>): any => ({
    info: (o: any, msg: string) => lines.push({ level: 'info', o: { ...ctx, ...o }, msg }),
    warn: (o: any, msg: string) => lines.push({ level: 'warn', o: { ...ctx, ...o }, msg }),
    error: (o: any, msg: string) => lines.push({ level: 'error', o: { ...ctx, ...o }, msg }),
    child: (c: Record<string, unknown>) => make({ ...ctx, ...c }),
  });
  return { lines, log: make({ traceId: 't-1' }) };
}
async function call(route: (req: any, res: any) => Promise<unknown>, req: any = {}) {
  const { lines, log } = logger();
  const out = { status: 200, body: undefined as any, lines };
  const res: any = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
  await route({ log, traceId: 't-1', headers: {}, ...req }, res);
  return out;
}
const repo = { listDueStripeCancellations, markStripeCancelled, markStripeCancelFailed };
const runTask = (getStripe = billing.stripe.getStripe) => call(billing.task.createCancelStripe({ repo, getStripe }));
const row = async (id: string) => (await pool.query(`SELECT attempts, cancelled_at, last_error, next_attempt_at FROM stripe_cancellations WHERE stripe_subscription_id = $1`, [id])).rows[0];
const quiet = { error: () => {} };

async function stripeSubscriber(uid: string, subId: string) {
  await seedUser(uid);
  await pool.query(
    `INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, stripe_subscription_id, stripe_customer_id)
     VALUES ($1, 'pro', 'active', 'active', 'stripe', NOW() + INTERVAL '20 days', $2, 'cus_' || $1)`,
    [uid, subId],
  );
}

describe('deleting an account', () => {
  it("records its Stripe subscription for cancellation, once, as the cascade takes the row", async () => {
    await stripeSubscriber('u1', 'sub_1');
    await seedUser('u2'); // no subscription
    // An App Store subscriber (or a trial): a subscription row with no Stripe id.
    await seedUser('u3');
    await pool.query(`INSERT INTO subscriptions (uid, plan, status, entitlement_state, source, current_period_end, apple_original_transaction_id)
                      VALUES ('u3', 'pro', 'active', 'active', 'apple_storekit', NOW() + INTERVAL '20 days', '2000000000000001')`);
    const first = await deleteAccountData({ uid: 'u1', traceId: 't-del' }, quiet);
    expect(first.stripeCancellations).toBe(1);
    expect((await pool.query(`SELECT 1 FROM subscriptions WHERE uid = 'u1'`)).rowCount).toBe(0);
    expect(await row('sub_1')).toMatchObject({ attempts: 0, cancelled_at: null });
    // A retried deletion adds nothing; an account with no Stripe subscription records none.
    expect((await deleteAccountData({ uid: 'u1', traceId: 't-del' }, quiet)).stripeCancellations).toBe(0);
    expect((await deleteAccountData({ uid: 'u2' }, quiet)).stripeCancellations).toBe(0);
    expect(await deleteAccountData({ uid: 'u3' }, quiet)).toMatchObject({ deleted: true, stripeCancellations: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM stripe_cancellations`)).rows[0].n).toBe(1);
  });
});

describe('a checkout completed after the account was deleted', () => {
  it('is cancelled, never activated, and Stripe is told 200 so it stops retrying', async () => {
    await seedUser('u1');
    await deleteAccountData({ uid: 'u1' }, quiet);
    const payload = JSON.stringify({
      id: 'evt_1', object: 'event', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', object: 'checkout.session', client_reference_id: 'u1', subscription: 'sub_late', customer: 'cus_1', metadata: { uid: 'u1' } } },
    });
    const header = billing.stripe.getStripe().webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    const out = await call(billing.webhook.stripeWebhookRoute, { body: Buffer.from(payload), headers: { 'stripe-signature': header } });
    expect(out.status).toBe(200);
    expect(await row('sub_late')).toMatchObject({ cancelled_at: null });
    expect((await pool.query(`SELECT 1 FROM subscriptions WHERE uid = 'u1'`)).rowCount).toBe(0);
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'stripe_checkout_after_deletion' }));
    expect(seen.filter((s) => s.path.startsWith('/v1/subscriptions'))).toEqual([]); // not even read
  });
});

describe("billing's cancel-stripe task", () => {
  it('cancels an active subscription with Stripe, immediately and without a final invoice', async () => {
    await stripeSubscriber('u1', 'sub_1');
    await deleteAccountData({ uid: 'u1', traceId: 't-del' }, quiet);
    subs.set('sub_1', active('sub_1'));
    const out = await runTask();
    expect(out).toMatchObject({ status: 200, body: { due: 1, cancelled: 1, alreadyOver: 0, failed: 0 } });
    const cancel = seen.find((s) => s.method === 'DELETE');
    expect(cancel?.path).toBe('/v1/subscriptions/sub_1');
    expect(Object.fromEntries(cancel!.form)).toMatchObject({ prorate: 'false', invoice_now: 'false' });
    expect((await row('sub_1')).cancelled_at).not.toBeNull();
    // Followable from the deletion: its traceId, with this run's beside it.
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'stripe_subscription_cancelled', o: expect.objectContaining({ traceId: 't-del', taskTraceId: 't-1' }) }));
    // Done: the next run has nothing, and doesn't call Stripe.
    seen.length = 0;
    expect((await runTask()).body).toEqual({ due: 0 });
    expect(seen).toEqual([]);
  });

  it('marks one already over done without cancelling: canceled, expired, or unknown to Stripe', async () => {
    for (const id of ['sub_canceled', 'sub_expired', 'sub_gone']) {
      await pool.query(`INSERT INTO stripe_cancellations (stripe_subscription_id) VALUES ($1)`, [id]);
    }
    subs.set('sub_canceled', { status: 200, body: { id: 'sub_canceled', object: 'subscription', status: 'canceled' } });
    subs.set('sub_expired', { status: 200, body: { id: 'sub_expired', object: 'subscription', status: 'incomplete_expired' } });
    const out = await runTask();
    expect(out.body).toMatchObject({ due: 3, cancelled: 0, alreadyOver: 3, failed: 0 });
    expect(seen.filter((s) => s.method === 'DELETE')).toEqual([]);
    for (const id of ['sub_canceled', 'sub_expired', 'sub_gone']) expect((await row(id)).cancelled_at, id).not.toBeNull();
  });

  it('backs off a failure, keeps only its code, and reports it stuck after too many', async () => {
    await pool.query(`INSERT INTO stripe_cancellations (stripe_subscription_id) VALUES ('sub_1')`);
    subs.set('sub_1', { status: 400, body: { error: { type: 'invalid_request_error', code: 'parameter_invalid_empty', message: 'Something with a customer email, a@example.com' } } });
    const out = await runTask();
    expect(out).toMatchObject({ status: 500, body: { failed: 1 } });
    const r = await row('sub_1');
    expect(r).toMatchObject({ attempts: 1, cancelled_at: null, last_error: 'parameter_invalid_empty' });
    expect(r.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(JSON.stringify(r)).not.toContain('example.com');
    // Not due again until its backoff: the next run leaves it.
    expect((await runTask()).body).toEqual({ due: 0 });
    // At the limit, every attempt says it's stuck.
    await pool.query(`UPDATE stripe_cancellations SET attempts = $1, next_attempt_at = NOW() WHERE stripe_subscription_id = 'sub_1'`, [STRIPE_CANCEL_STUCK_ATTEMPTS - 1]);
    const stuck = await runTask();
    expect(stuck.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'stripe_cancellation_stuck', o: expect.objectContaining({ stripeSubscriptionId: 'sub_1', attempts: STRIPE_CANCEL_STUCK_ATTEMPTS }) }));
    const next = (await row('sub_1')).next_attempt_at.getTime() - Date.now();
    expect(next).toBeLessThanOrEqual(86_400_000 + 5_000); // capped at a day
  });

  it('says so, and cancels nothing, when something is waiting and there is no Stripe key; nothing waiting asks nothing', async () => {
    const noKey = () => { throw Object.assign(new Error('stripe_secret_key_missing'), { status: 503 }); };
    expect((await runTask(noKey)).body).toEqual({ due: 0 });
    await pool.query(`INSERT INTO stripe_cancellations (stripe_subscription_id) VALUES ('sub_1')`);
    const out = await runTask(noKey);
    expect(out.status).toBe(500);
    expect(out.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'stripe_cancel_not_configured', o: expect.objectContaining({ due: 1 }) }));
    expect(await row('sub_1')).toMatchObject({ attempts: 0, cancelled_at: null });
  });
});
