import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPool } from '@algominutes/db';
import { pool, resetDb, seedUser } from './helpers';

// The Android rail's server check, through the real googleapis client, against
// a local stand-in for the Play Developer API (PLAY_API_ROOT_URL, unset when
// deployed). It pins what a googleapis major could change: the request the
// androidpublisher v3 client sends for purchases.subscriptions.get, the auth
// header, and the fields we read back. Real Postgres for the verify route.
type Seen = { method: string; path: string; auth: string | undefined };
const seen: Seen[] = [];
const EXPIRY_MS = Math.floor(Date.now() / 1000 + 30 * 86_400) * 1000; // a month ahead: the grant is live
let answer: { status: number; body: unknown } = { status: 200, body: {} };

const server = http.createServer((req, res) => {
  seen.push({ method: req.method || '', path: decodeURIComponent((req.url || '').split('?')[0]), auth: req.headers.authorization });
  res.writeHead(answer.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer.body));
});

let play: any;
let verify: any;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  Object.assign(process.env, { PLAY_API_ROOT_URL: `http://127.0.0.1:${port}/`, PLAY_PACKAGE_NAME: 'app.algominutes.test' });
  play = await import('../../services/billing/src/lib/google-play.js');
  verify = await import('../../services/billing/src/routes/verify.js');
});
beforeEach(async () => {
  seen.length = 0;
  answer = {
    status: 200,
    body: { kind: 'androidpublisher#subscriptionPurchase', expiryTimeMillis: String(EXPIRY_MS), paymentState: 1, acknowledgementState: 1, autoRenewing: true },
  };
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

describe('Google Play: purchases.subscriptions.get', () => {
  it('asks Play for the token under our package, with a bearer token, and reads the expiry and states', async () => {
    const sub = await play.verifyPlaySubscription({ productId: 'pro_monthly', purchaseToken: 'tok-1' });
    expect(seen).toEqual([{
      method: 'GET',
      path: '/androidpublisher/v3/applications/app.algominutes.test/purchases/subscriptions/pro_monthly/tokens/tok-1',
      auth: 'Bearer stand-in',
    }]);
    expect(sub).toMatchObject({
      purchaseToken: 'tok-1', productId: 'pro_monthly',
      currentPeriodEnd: new Date(EXPIRY_MS).toISOString(), paymentState: 1, cancelReason: null, acknowledgementState: 1,
    });
  });

  it('an error from Play is thrown (the webhook answers 500 so Pub/Sub redelivers)', async () => {
    answer = { status: 410, body: { error: { code: 410, message: 'The subscription purchase is no longer available.' } } };
    await expect(play.verifyPlaySubscription({ productId: 'pro_monthly', purchaseToken: 'tok-gone' })).rejects.toMatchObject({ status: 410 });
  });

  it('the verify route grants Pro until the expiry Play reports', async () => {
    const r = await call(verify.verifyPurchaseRoute, { uid: 'u1', body: { rail: 'google_play', productId: 'pro_monthly', purchaseToken: 'tok-1' } });
    expect(r).toEqual({ status: 200, body: { ok: true, entitlementState: 'active' } });
    const row = (await pool.query(`SELECT plan, source, google_purchase_token, current_period_end FROM subscriptions WHERE uid = 'u1'`)).rows[0];
    expect(row).toEqual({ plan: 'pro', source: 'google_play', google_purchase_token: 'tok-1', current_period_end: new Date(EXPIRY_MS) });
  });
});
