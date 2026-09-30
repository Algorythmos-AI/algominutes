import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { b64u, makeApplePki, type ApplePki } from './helpers/apple-pki';
// @ts-expect-error: plain ESM modules, no type declarations
import { appStoreServerJwt, createAppStoreServerClient, createAppStoreServer, AppStoreServerError, HOSTS } from '../services/billing/src/lib/app-store-server.js';
// @ts-expect-error: plain ESM module, no type declarations
import { appleChange, createReconcileApple } from '../services/billing/src/tasks/reconcile-apple.js';
// @ts-expect-error: plain ESM module, no type declarations
import { buildApp } from '../services/billing/src/app.js';
// @ts-expect-error: plain CJS module, no type declarations
import taskAuthModule from '../packages/ai/src/task-auth.cjs';

// RELEASE.md PR 26: billing asks Apple (App Store Server API) what an App Store subscription's state is now,
// so a notification that never arrived can't leave an entitlement wrong. Apple's answer is verified like a
// notification: a throwaway PKI stands in for Apple's (tests/helpers/apple-pki.ts).

const BUNDLE = 'com.algorythmos.algominutes';
const OTID = '2000000123456789';
const END = Date.parse('2099-01-01T00:00:00Z');
const NOW = Date.parse('2026-10-01T00:00:00Z');

let pki: ApplePki;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(() => { pki = makeApplePki(); });
afterAll(() => pki.cleanup());

const tx = (over: Record<string, unknown> = {}) => pki.jws({
  originalTransactionId: OTID, transactionId: '2000000999', productId: 'pro_monthly', expiresDate: END,
  bundleId: BUNDLE, environment: 'Production', ...over,
});
const answer = (environment: string, last: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
  environment, bundleId: BUNDLE,
  data: [{ subscriptionGroupIdentifier: '21000000', lastTransactions: [{ originalTransactionId: OTID, status: 1, signedTransactionInfo: tx({ environment }), signedRenewalInfo: pki.jws({ originalTransactionId: OTID, autoRenewStatus: 1 }), ...last }] }],
  ...body,
});

type Reply = { status: number; body?: unknown } | Error;
function fakeApple(replies: Record<string, Reply>) {
  const calls: { url: string; auth: string }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization });
    const env = url.startsWith(HOSTS.Sandbox) ? 'Sandbox' : 'Production';
    const r = replies[env] ?? { status: 404, body: { errorCode: 4040010, errorMessage: 'Transaction id not found.' } };
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { calls, fetchImpl };
}
const client = (fetchImpl: unknown, over: Record<string, unknown> = {}) => createAppStoreServerClient({
  issuerId: 'issuer-1', keyId: 'KEY123', privateKeyPem: PEM, fetchImpl, now: () => NOW, verifyOpts: { root: pki.root }, ...over,
});
async function thrown(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as any;
  }
  throw new Error('expected a throw');
}

describe("the App Store Server API's bearer token", () => {
  it('is an ES256 JWT for our app, as Apple documents it, lasting under an hour', () => {
    const jwt = appStoreServerJwt({ issuerId: 'issuer-1', keyId: 'KEY123', privateKeyPem: PEM, nowMs: NOW });
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'issuer-1', iat: NOW / 1000, aud: 'appstoreconnect-v1', bid: BUNDLE });
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('is reused for a while, then made anew', async () => {
    let t = NOW;
    const apple = fakeApple({ Production: { status: 200, body: answer('Production') } });
    const c = client(apple.fetchImpl, { now: () => t });
    await c.subscriptionStatus(OTID);
    t += 60_000;
    await c.subscriptionStatus(OTID);
    t += 20 * 60_000;
    await c.subscriptionStatus(OTID);
    expect(apple.calls[0].auth).toBe(apple.calls[1].auth);
    expect(apple.calls[2].auth).not.toBe(apple.calls[1].auth);
    expect(apple.calls[0].auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe("a subscription's status, from Apple", () => {
  it('asks production first, and answers what Apple says, verified', async () => {
    const apple = fakeApple({ Production: { status: 200, body: answer('Production') } });
    expect(await client(apple.fetchImpl).subscriptionStatus(OTID)).toEqual({
      environment: 'Production', status: 'active', statusCode: 1, productId: 'pro_monthly',
      currentPeriodEnd: new Date(END).toISOString(), revoked: false, graceEnd: null,
    });
    expect(apple.calls.map((c) => c.url)).toEqual([`https://api.storekit.apple.com/inApps/v1/subscriptions/${OTID}`]);
  });

  it("asks the sandbox when production doesn't know it (TestFlight, App Review), and answers null when neither does", async () => {
    const apple = fakeApple({ Sandbox: { status: 200, body: answer('Sandbox') } });
    expect(await client(apple.fetchImpl).subscriptionStatus(OTID)).toMatchObject({ environment: 'Sandbox', status: 'active' });
    expect(apple.calls.map((c) => c.url)).toEqual([
      `https://api.storekit.apple.com/inApps/v1/subscriptions/${OTID}`,
      `https://api.storekit-sandbox.apple.com/inApps/v1/subscriptions/${OTID}`,
    ]);
    expect(await client(fakeApple({}).fetchImpl).subscriptionStatus(OTID)).toBeNull();
  });

  it('reads a grace period, a billing retry, an expiry and a refund', async () => {
    const status = async (last: Record<string, unknown>) => client(fakeApple({ Production: { status: 200, body: answer('Production', last) } }).fetchImpl).subscriptionStatus(OTID);
    const grace = Date.parse('2099-01-17T00:00:00Z');
    expect(await status({ status: 4, signedRenewalInfo: pki.jws({ originalTransactionId: OTID, gracePeriodExpiresDate: grace }) }))
      .toMatchObject({ status: 'grace', graceEnd: new Date(grace).toISOString() });
    expect(await status({ status: 3 })).toMatchObject({ status: 'billing_retry' });
    expect(await status({ status: 2 })).toMatchObject({ status: 'expired' });
    expect(await status({ status: 5, signedTransactionInfo: tx({ revocationDate: NOW }) })).toMatchObject({ status: 'revoked', revoked: true });
    expect(await status({ status: 9 })).toMatchObject({ status: 'unknown', statusCode: 9 });
    expect(await status({ originalTransactionId: '2000000000000001' })).toBeNull(); // another of the customer's subscriptions
  });

  it("refuses an answer that isn't Apple's, isn't ours, or isn't the subscription asked about", async () => {
    const status = (body: unknown) => client(fakeApple({ Production: { status: 200, body } }).fetchImpl).subscriptionStatus(OTID);
    const foreignRoot = pki.jws({ originalTransactionId: OTID, bundleId: BUNDLE, environment: 'Production', expiresDate: END }, { leafName: 'otherleaf', chain: ['otherleaf', 'otherint', 'other'] });
    expect((await thrown(status(answer('Production', { signedTransactionInfo: foreignRoot })))).status).toBe(400);
    expect((await thrown(status(answer('Production', {}, { bundleId: 'com.example.other' })))).message).toMatch(/bundle id/);
    expect((await thrown(status(answer('Production', { signedTransactionInfo: tx({ bundleId: 'com.example.other' }) })))).message).toMatch(/bundle id/);
    expect((await thrown(status(answer('Production', { signedTransactionInfo: tx({ originalTransactionId: '2000000000000001' }) })))).message).toMatch(/another subscription/);
    expect((await thrown(status(answer('Production', { signedRenewalInfo: pki.jws({ originalTransactionId: '2000000000000001' }) })))).message).toMatch(/renewal info/);
    // A sandbox purchase can't be passed off as a production one, nor the answer's environment swapped.
    expect((await thrown(status(answer('Production', { signedTransactionInfo: tx({ environment: 'Sandbox' }) })))).message).toMatch(/a Sandbox transaction from Production/);
    expect((await thrown(status(answer('Production', {}, { environment: 'Sandbox' })))).message).toMatch(/asked Production, answered "Sandbox"/);
    // What Apple's unsigned envelope says is quoted short, never at length.
    expect((await thrown(status(answer('Production', {}, { environment: 'x'.repeat(5000) })))).message.length).toBeLessThan(120);
    expect((await thrown(status(answer('Production', { signedTransactionInfo: undefined })))).message).toMatch(/no transaction info/);
  });

  it('says why Apple could not be asked, and never tries the sandbox after a refusal or an outage', async () => {
    for (const [reply, unauthorized] of [[{ status: 401 }, true], [{ status: 403, body: { errorCode: 4030000 } }, true], [{ status: 429, body: { errorCode: 4290000 } }, false], [{ status: 500, body: { errorCode: 5000000 } }, false]] as const) {
      const apple = fakeApple({ Production: reply, Sandbox: { status: 200, body: answer('Sandbox') } });
      const err = await thrown(client(apple.fetchImpl).subscriptionStatus(OTID));
      expect(err).toBeInstanceOf(AppStoreServerError);
      expect(err.status).toBe(reply.status);
      expect(err.unauthorized).toBe(unauthorized);
      expect(apple.calls).toHaveLength(1);
    }
    const net = Object.assign(new TypeError('fetch failed: https://api.storekit.apple.com secret detail'), { cause: { code: 'ENOTFOUND' } });
    const err = await thrown(client(fakeApple({ Production: net }).fetchImpl).subscriptionStatus(OTID));
    expect(err).toMatchObject({ code: 'ENOTFOUND', status: 0 });
    expect(err.message).toBe('app store Production: network error');
  });

  it('asks only about a transaction id, never another path', async () => {
    const apple = fakeApple({});
    for (const id of ['', '../../v1/notifications/test', '123?x=1', null]) {
      expect((await thrown(client(apple.fetchImpl).subscriptionStatus(id))).status).toBe(400);
    }
    expect(apple.calls).toEqual([]);
  });
});

describe("this environment's client", () => {
  it('is off until the owner sets the ids and adds the key, and follows a rotated key', async () => {
    const made: string[] = [];
    const createClient = ({ privateKeyPem }: { privateKeyPem: string }) => { made.push(privateKeyPem); return { pem: privateKeyPem }; };
    let pem: string | null = null;
    const readSecret = async (id: string) => { expect(id).toBe('app-store-server-key'); return pem; };
    expect(await createAppStoreServer({ env: {}, readSecret, createClient })()).toEqual({ missing: 'env' });
    const get = createAppStoreServer({ env: { APPLE_ISSUER_ID: 'i', APPLE_KEY_ID: 'k' }, readSecret, createClient });
    expect(await get()).toEqual({ missing: 'secret' });
    pem = 'pem-1';
    expect(await get()).toEqual({ client: { pem: 'pem-1' } });
    await get();
    pem = 'pem-2';
    expect(await get()).toEqual({ client: { pem: 'pem-2' } });
    expect(made).toEqual(['pem-1', 'pem-2']);
  });
});

describe("what Apple's answer changes", () => {
  const row = { status: 'active', plan: 'pro', currentPeriodEnd: '2026-10-01T00:00:00.000Z' };
  const apple = (over: Record<string, unknown>) => ({ environment: 'Production', status: 'active', productId: 'pro_monthly', currentPeriodEnd: '2026-11-01T00:00:00.000Z', revoked: false, graceEnd: null, ...over });

  it('a renewal the notification missed moves the period on; the same answer changes nothing', () => {
    expect(appleChange(row, apple({}), NOW)).toEqual({ status: 'active', currentPeriodEnd: '2026-11-01T00:00:00.000Z', plan: 'pro' });
    expect(appleChange({ ...row, currentPeriodEnd: '2026-11-01T00:00:00Z' }, apple({}), NOW)).toBeNull();
    expect(appleChange(row, null, NOW)).toBeNull();
    expect(appleChange(row, apple({ status: 'unknown' }), NOW)).toBeNull();
  });

  it('a refund or revocation ends it now; an expiry at its end, never later than now', () => {
    const later = { ...row, currentPeriodEnd: '2026-10-20T00:00:00.000Z' };
    expect(appleChange(later, apple({ revoked: true }), NOW)).toEqual({ status: 'refunded', currentPeriodEnd: new Date(NOW).toISOString(), plan: 'pro' });
    expect(appleChange(later, apple({ status: 'revoked' }), NOW)).toMatchObject({ status: 'refunded', currentPeriodEnd: new Date(NOW).toISOString() });
    expect(appleChange(row, apple({ status: 'expired', currentPeriodEnd: '2026-09-30T00:00:00.000Z' }), NOW)).toMatchObject({ status: 'expired', currentPeriodEnd: '2026-09-30T00:00:00.000Z' });
    expect(appleChange(row, apple({ status: 'expired', currentPeriodEnd: '2026-12-01T00:00:00.000Z' }), NOW)).toMatchObject({ status: 'expired', currentPeriodEnd: new Date(NOW).toISOString() });
  });

  it('a grace period keeps the service until grace ends; a billing retry without one has lapsed', () => {
    expect(appleChange(row, apple({ status: 'grace', currentPeriodEnd: '2026-09-30T00:00:00.000Z', graceEnd: '2026-10-16T00:00:00.000Z' }), NOW))
      .toEqual({ status: 'past_due', currentPeriodEnd: '2026-10-16T00:00:00.000Z', plan: 'pro' });
    expect(appleChange(row, apple({ status: 'billing_retry', currentPeriodEnd: '2026-09-30T00:00:00.000Z' }), NOW))
      .toEqual({ status: 'past_due', currentPeriodEnd: '2026-09-30T00:00:00.000Z', plan: 'pro' });
  });
});

type Line = { level: string; o: Record<string, any>; msg: string };
function capture() {
  const lines: Line[] = [];
  const make = (ctx: Record<string, unknown>): any => ({
    info: (o: any, msg: string) => lines.push({ level: 'info', o: { ...ctx, ...o }, msg }),
    warn: (o: any, msg: string) => lines.push({ level: 'warn', o: { ...ctx, ...o }, msg }),
    error: (o: any, msg: string) => lines.push({ level: 'error', o: { ...ctx, ...o }, msg }),
    child: (c: Record<string, unknown>) => make({ ...ctx, ...c }),
  });
  return { lines, log: make({ traceId: 't-1' }) };
}
async function run(route: (req: any, res: any) => Promise<unknown>) {
  const { lines, log } = capture();
  const out = { status: 0, body: undefined as any };
  const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
  await route({ log }, res);
  return { ...out, lines };
}
let nextId = 1000;
const dueRow = (uid: string, over: Record<string, unknown> = {}) => ({ uid, originalTransactionId: `200000000000${nextId++}`, status: 'active', plan: 'pro', currentPeriodEnd: '2026-09-30T22:00:00.000Z', version: '1', ...over });

describe('the reconcile task', () => {
  it('does nothing, and says so, until this environment has a key', async () => {
    let listed = false;
    const route = createReconcileApple({ appStoreServer: async () => ({ missing: 'secret' }), repo: { listAppleSubscriptionsDue: async () => { listed = true; return []; } } });
    const out = await run(route);
    expect(out).toMatchObject({ status: 200, body: { skipped: 'not_configured' } });
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'apple_reconcile_not_configured', o: expect.objectContaining({ missing: 'secret' }) }));
    expect(listed).toBe(false);
  });

  it('checks each due subscription on its own: writes what changed, leaves a raced row, and counts a failure', async () => {
    const rows = [dueRow('u-renewed'), dueRow('u-raced'), dueRow('u-refunded', { currentPeriodEnd: '2026-10-20T00:00:00.000Z' }), dueRow('u-down'), dueRow('u-unknown')];
    const answers: Record<string, unknown> = {
      [rows[0].originalTransactionId]: { environment: 'Sandbox', status: 'active', productId: 'pro_monthly', currentPeriodEnd: '2026-10-31T22:00:00.000Z', revoked: false, graceEnd: null },
      [rows[1].originalTransactionId]: { environment: 'Production', status: 'expired', productId: 'pro_monthly', currentPeriodEnd: '2026-09-30T22:00:00.000Z', revoked: false, graceEnd: null },
      [rows[2].originalTransactionId]: { environment: 'Production', status: 'revoked', productId: 'pro_monthly', currentPeriodEnd: '2026-10-20T00:00:00.000Z', revoked: true, graceEnd: null },
      [rows[3].originalTransactionId]: new AppStoreServerError('app store Production: HTTP 500', { status: 500 }),
      [rows[4].originalTransactionId]: null,
    };
    const recorded: [string, unknown][] = [];
    const events: unknown[] = [];
    const route = createReconcileApple({
      now: () => NOW,
      appStoreServer: async () => ({ client: { subscriptionStatus: async (id: string) => { const a = answers[id]; if (a instanceof Error) throw a; return a; } } }),
      repo: {
        listAppleSubscriptionsDue: async (limit: number) => { expect(limit).toBe(100); return rows; },
        recordAppleCheck: async (row: { uid: string }, change: unknown) => { recorded.push([row.uid, change]); return row.uid === 'u-raced' ? 'raced' : change ? 'updated' : 'checked'; },
        trackEvent: async (e: unknown) => { events.push(e); },
      },
    });
    const out = await run(route);
    expect(out.status).toBe(500); // one failed: Cloud Scheduler records the run as failed
    expect(out.body).toEqual({ due: 5, checked: 4, updated: 2, raced: 1, unknown: 1, failed: 1, deferred: 0 });
    expect(recorded).toEqual([
      ['u-renewed', { status: 'active', currentPeriodEnd: '2026-10-31T22:00:00.000Z', plan: 'pro' }],
      ['u-raced', { status: 'expired', currentPeriodEnd: '2026-09-30T22:00:00.000Z', plan: 'pro' }],
      ['u-refunded', { status: 'refunded', currentPeriodEnd: new Date(NOW).toISOString(), plan: 'pro' }],
      ['u-unknown', null],
    ]);
    expect(events).toEqual([{ uid: 'u-refunded', event: 'cancellation', props: { rail: 'apple_storekit', reason: 'reconcile_refunded' } }]);
    const reconciled = out.lines.find((l) => l.msg === 'apple_reconciled' && l.o.uid === 'u-renewed');
    expect(reconciled?.o).toMatchObject({ traceId: 't-1', userId: 'u-renewed', railId: rows[0].originalTransactionId, environment: 'Sandbox', appleStatus: 'active' });
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'apple_reconcile_item_failed', o: expect.objectContaining({ userId: 'u-down', status: 500 }) }));
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'apple_subscription_not_found', o: expect.objectContaining({ userId: 'u-unknown' }) }));
    expect(out.lines).toContainEqual(expect.objectContaining({ msg: 'apple_reconcile_done', o: expect.objectContaining({ updated: 2, failed: 1 }) }));
  });

  it('stops at a refusal of our key: every call would fail the same way', async () => {
    const asked: string[] = [];
    const route = createReconcileApple({
      appStoreServer: async () => ({ client: { subscriptionStatus: async (id: string) => { asked.push(id); throw new AppStoreServerError('app store Production: HTTP 401', { status: 401 }); } } }),
      repo: { listAppleSubscriptionsDue: async () => [dueRow('u-1'), dueRow('u-2')], recordAppleCheck: async () => { throw new Error('not reached'); } },
    });
    const out = await run(route);
    expect(out.status).toBe(500);
    expect(asked).toHaveLength(1);
    expect(out.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'apple_server_api_unauthorized', o: expect.objectContaining({ status: 401, userId: 'u-1' }) }));
  });

  it("a key that can't be read is logged and fails the run, before anything is listed", async () => {
    let listed = false;
    const route = createReconcileApple({
      appStoreServer: async () => { throw new Error('secret app-store-server-key: HTTP 403'); },
      repo: { listAppleSubscriptionsDue: async () => { listed = true; return []; } },
    });
    const out = await run(route);
    expect(out.status).toBe(500);
    expect(listed).toBe(false);
    expect(out.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'apple_reconcile_failed', o: expect.objectContaining({ step: 'key', traceId: 't-1' }) }));
  });

  it("a failed listing is logged and fails the run; a failed funnel event doesn't fail the check", async () => {
    const failing = createReconcileApple({ appStoreServer: async () => ({ client: {} }), repo: { listAppleSubscriptionsDue: async () => { throw new Error('pg down'); } } });
    const out = await run(failing);
    expect(out.status).toBe(500);
    expect(out.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'apple_reconcile_failed' }));

    const route = createReconcileApple({
      now: () => NOW,
      appStoreServer: async () => ({ client: { subscriptionStatus: async () => ({ environment: 'Production', status: 'expired', productId: 'pro_monthly', currentPeriodEnd: '2026-09-30T22:00:00.000Z', revoked: false, graceEnd: null }) } }),
      repo: { listAppleSubscriptionsDue: async () => [dueRow('u-1')], recordAppleCheck: async () => 'updated', trackEvent: async () => { throw new Error('analytics down'); } },
    });
    const ok = await run(route);
    expect(ok).toMatchObject({ status: 200, body: { updated: 1, failed: 0 } });
    expect(ok.lines).toContainEqual(expect.objectContaining({ level: 'error', msg: 'apple_reconcile_event_failed', o: expect.objectContaining({ userId: 'u-1' }) }));
  });

  it('stops starting checks before the request would time out, and leaves the rest for the next run', async () => {
    let t = NOW;
    const route = createReconcileApple({
      now: () => t,
      budgetMs: 40_000,
      appStoreServer: async () => ({ client: { subscriptionStatus: async () => { t += 15_000; return null; } } }),
      repo: { listAppleSubscriptionsDue: async () => [dueRow('u-1'), dueRow('u-2'), dueRow('u-3'), dueRow('u-4'), dueRow('u-5')], recordAppleCheck: async () => 'checked' },
    });
    const out = await run(route);
    expect(out).toMatchObject({ status: 200, body: { checked: 3, deferred: 2 } });
  });
});

describe("billing's /tasks", () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  async function serve(app: any) {
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    return (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers });
  }

  it('run only for a Google-signed token issued to run-jobs, for exactly that URL', async () => {
    const audiences: string[] = [];
    const verifier = {
      verifyIdToken: async ({ idToken, audience }: { idToken: string; audience: string }) => {
        audiences.push(audience);
        if (idToken === 'bad') throw new Error('invalid signature');
        return { getPayload: () => ({ email: idToken === 'jobs' ? 'run-jobs@p.iam.gserviceaccount.com' : 'someone@example.com', email_verified: true }) };
      },
    };
    let ran = 0;
    const post = await serve(buildApp({
      env: {},
      taskAuth: taskAuthModule.createTaskAuth({ baseUrl: 'https://billing-1.region.run.app/', serviceAccountEmail: 'run-jobs@p.iam.gserviceaccount.com', client: verifier }),
      tasks: { 'reconcile-apple': async (_req: any, res: any) => { ran += 1; res.status(200).json({ ok: true }); } },
    }));
    expect((await post('/tasks/reconcile-apple')).status).toBe(401);
    expect((await post('/tasks/reconcile-apple', { authorization: 'Bearer bad' })).status).toBe(401);
    expect((await post('/tasks/reconcile-apple', { authorization: 'Bearer other' })).status).toBe(403);
    expect(ran).toBe(0);
    expect((await post('/tasks/reconcile-apple?x=1', { authorization: 'Bearer jobs' })).status).toBe(200);
    expect(ran).toBe(1);
    expect(audiences.at(-1)).toBe('https://billing-1.region.run.app/tasks/reconcile-apple');
    expect((await post('/tasks/nope', { authorization: 'Bearer jobs' })).status).toBe(404);
  });

  it("never log the caller's token, or a person's email, whatever the caller sends", async () => {
    const lines: Line[] = [];
    const log: any = {
      warn: (o: any, msg: string) => lines.push({ level: 'warn', o, msg }),
      error: (o: any, msg: string) => lines.push({ level: 'error', o, msg }),
    };
    // A token-shaped fake (header.claims.signature), built here so no literal looks like a credential.
    const token = [b64u({ alg: 'RS256' }), b64u({ email: 'person@example.com' }), Buffer.from('signature').toString('base64url')].join('.');
    const libraryError = (message: string) => ({ verifyIdToken: async () => { throw new Error(message); } });
    const check = async (client: unknown) => {
      const auth = taskAuthModule.createTaskAuth({ baseUrl: 'https://billing-1.region.run.app', serviceAccountEmail: 'run-jobs@p.iam.gserviceaccount.com', client });
      const res: any = { status: () => res, json: () => res };
      await auth({ headers: { authorization: `Bearer ${token}` }, originalUrl: '/tasks/reconcile-apple', log }, res, () => {});
      return lines.at(-1)!;
    };
    // google-auth-library's own messages (9.x) quote the token or its decoded claims.
    for (const [message, reason] of [
      [`Invalid token signature: ${token}`, 'bad_signature'],
      [`Wrong number of segments in token: ${token}`, 'malformed'],
      [`Can't parse token envelope: ${token.split('.')[0]}`, 'malformed'],
      [`Token used too late, 1 > 0: {"email":"person@example.com"}`, 'expired'],
      ['Wrong recipient, payload audience != requiredAudience', 'wrong_audience'],
      ['socket hang up', 'other'],
    ] as const) {
      const line = await check(libraryError(message));
      expect(line).toMatchObject({ msg: 'task_auth_invalid_token', o: { reason, audience: 'https://billing-1.region.run.app/tasks/reconcile-apple' } });
      // Serialized as the logger does an error (its message and stack), so an `err` logged whole would show.
      const logged = JSON.stringify(line, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
      expect(logged).not.toContain(token.split('.')[1]);
      expect(logged).not.toContain('person@example.com');
    }
    const person = await check({ verifyIdToken: async () => ({ getPayload: () => ({ email: 'person@example.com', email_verified: true }) }) });
    expect(person).toMatchObject({ msg: 'task_auth_wrong_identity', o: { email: null, emailVerified: true } });
    const workload = await check({ verifyIdToken: async () => ({ getPayload: () => ({ email: 'other-sa@p.iam.gserviceaccount.com', email_verified: true }) }) });
    expect(workload.o.email).toBe('other-sa@p.iam.gserviceaccount.com');
  });

  it('refuse every call when the service has no URL or jobs account to check against', async () => {
    const post = await serve(buildApp({ env: {}, taskAuth: taskAuthModule.createTaskAuth({ baseUrl: '', serviceAccountEmail: '' }) }));
    expect((await post('/tasks/reconcile-apple', { authorization: 'Bearer jobs' })).status).toBe(503);
  });

  it('wire the reconcile to this environment: with no key set up it checks nothing', async () => {
    const post = await serve(buildApp({ env: {}, taskAuth: (_req: any, _res: any, next: () => void) => next() }));
    const res = await post('/tasks/reconcile-apple');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: 'not_configured' });
  });
});
