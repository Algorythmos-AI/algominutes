import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import type { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { b64u, makeApplePki, type ApplePki } from './helpers/apple-pki';
// @ts-expect-error: plain ESM modules, no type declarations
import { APPLE_ROOT_G3_SHA256, appleRootCA, verifyAndDecodeJws, verifyAppleJws, verifyAppleNotification, verifyStoreKitPurchase, unverifiedAppleJwsAllowed } from '../services/billing/src/lib/apple.js';
// @ts-expect-error: plain ESM module, no type declarations
import { appleWebhookRoute } from '../services/billing/src/webhooks/apple.js';

// Apple's JWS (StoreKit 2 transactions, App Store Server Notifications) is
// trusted only when it chains to Apple Root CA - G3 (plan PR-32). Here a
// throwaway PKI built with openssl stands in for Apple's (tests/helpers/apple-pki.ts),
// passed as `root`, so each check can be shown refusing what it should.

let pki: ApplePki;
let root: X509Certificate;
beforeAll(() => {
  pki = makeApplePki();
  root = pki.root;
});
afterAll(() => pki.cleanup());

const jws = (payload: unknown, opts?: { leafName?: string; chain?: string[]; alg?: string }) => pki.jws(payload, opts);
const PURCHASE = { originalTransactionId: '2000000123456789', productId: 'pro_monthly', expiresDate: Date.parse('2099-01-01'), bundleId: 'com.algorythmos.algominutes' };
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number; message: string });
  }
  throw new Error('expected a refusal');
};

const saved = { flag: process.env.APPLE_JWS_TRUST_UNVERIFIED, k: process.env.K_SERVICE };
afterEach(() => {
  for (const [key, v] of [['APPLE_JWS_TRUST_UNVERIFIED', saved.flag], ['K_SERVICE', saved.k]] as const) {
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

describe('an Apple-signed JWS', () => {
  it('is accepted when it chains to the pinned root, and its payload returned', () => {
    expect(verifyAppleJws(jws(PURCHASE), { root }).payload).toMatchObject({ originalTransactionId: '2000000123456789' });
    // Apple sometimes sends only leaf and intermediate.
    expect(verifyAppleJws(jws(PURCHASE, { chain: ['leaf', 'int'] }), { root }).payload.productId).toBe('pro_monthly');
    expect(verifyStoreKitPurchase(jws(PURCHASE), { root })).toMatchObject({ originalTransactionId: '2000000123456789', bundleId: 'com.algorythmos.algominutes' });
  });

  it('is refused when anything was changed after signing', () => {
    const [h, , s] = jws(PURCHASE).split('.');
    const forged = `${h}.${b64u({ ...PURCHASE, expiresDate: Date.parse('2199-01-01') })}.${s}`;
    expect(refused(() => verifyAppleJws(forged, { root }))).toMatchObject({ status: 400, message: expect.stringMatching(/bad signature/) });
  });

  it('is refused when its chain leads to another root, even one the token itself brings', () => {
    expect(refused(() => verifyAppleJws(jws(PURCHASE, { leafName: 'otherleaf', chain: ['otherleaf', 'otherint', 'other'] }), { root })).message).toMatch(/not Apple’s root/);
    expect(refused(() => verifyAppleJws(jws(PURCHASE, { leafName: 'otherleaf', chain: ['otherleaf', 'otherint'] }), { root })).message).toMatch(/intermediate not issued/);
    // Someone else's leaf, set beside Apple's genuine intermediate: the intermediate checks out, the leaf mustn't.
    expect(refused(() => verifyAppleJws(jws(PURCHASE, { leafName: 'otherleaf', chain: ['otherleaf', 'int', 'root'] }), { root })).message).toMatch(/leaf not issued/);
  });

  it("is refused when the leaf isn't an App Store certificate, or signs with a key the chain doesn't vouch for", () => {
    expect(refused(() => verifyAppleJws(jws(PURCHASE, { leafName: 'plainleaf', chain: ['plainleaf', 'int'] }), { root })).message).toMatch(/not an App Store certificate/);
    expect(refused(() => verifyAppleJws(jws(PURCHASE, { leafName: 'otherleaf', chain: ['leaf', 'int'] }), { root })).message).toMatch(/bad signature/);
  });

  it('is refused outside its certificates’ validity at signedDate, or with another alg', () => {
    expect(refused(() => verifyAppleJws(jws({ ...PURCHASE, signedDate: Date.parse('2200-01-01') }), { root })).message).toMatch(/not valid/);
    for (const alg of ['none', 'HS256', 'RS256']) expect(refused(() => verifyAppleJws(jws(PURCHASE, { alg }), { root })).message, alg).toMatch(/ES256/);
    expect(refused(() => verifyAppleJws('a.b', { root })).status).toBe(400);
  });

  it('a notification is verified whole: itself, the transaction inside it, and both for our app', () => {
    const ours = { bundleId: 'com.algorythmos.algominutes' };
    const note = (data: unknown) => jws({ notificationType: 'DID_RENEW', data });
    expect(verifyAppleNotification(note({ ...ours, signedTransactionInfo: jws(PURCHASE) }), { root }).tx).toMatchObject({ originalTransactionId: '2000000123456789' });
    expect(refused(() => verifyAppleNotification(note(ours), { root })).message).toMatch(/no transaction info/);
    expect(refused(() => verifyAppleNotification(note({ bundleId: 'com.example.other', signedTransactionInfo: jws(PURCHASE) }), { root })).message).toMatch(/bundle id/);
    expect(refused(() => verifyAppleNotification(note({ ...ours, signedTransactionInfo: jws({ ...PURCHASE, bundleId: 'com.example.other' }) }), { root })).message).toMatch(/bundle id/);
    const forgedTx = `${b64u({ alg: 'ES256', x5c: ['x'] })}.${b64u(PURCHASE)}.sig`;
    expect(refused(() => verifyAppleNotification(note({ ...ours, signedTransactionInfo: forgedTx }), { root })).status).toBe(400);
    expect(refused(() => verifyAppleNotification(undefined, { root })).status).toBe(400);
  });

  it("a genuine purchase for another app grants nothing", () => {
    expect(refused(() => verifyStoreKitPurchase(jws({ ...PURCHASE, bundleId: 'com.example.other' }), { root }))).toMatchObject({ status: 400, message: expect.stringMatching(/bundle id/) });
  });
});

describe('the pinned root', () => {
  it("is Apple Root CA - G3, by Apple's published fingerprint", () => {
    const pinned = appleRootCA();
    expect(pinned.fingerprint256).toBe(APPLE_ROOT_G3_SHA256);
    expect(pinned.subject).toMatch(/CN=Apple Root CA - G3/);
  });

  it('turns away a forged purchase and a forged notification (they chain to nothing Apple signed)', async () => {
    delete process.env.APPLE_JWS_TRUST_UNVERIFIED;
    expect(refused(() => verifyStoreKitPurchase(jws(PURCHASE))).status).toBe(400);
    const out = { status: 0, body: undefined as unknown };
    const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
    const noop = () => {};
    const log = { warn: noop, info: noop, error: noop, child: () => log };
    await appleWebhookRoute({ body: { signedPayload: jws({ notificationType: 'DID_RENEW', data: { bundleId: 'com.algorythmos.algominutes', signedTransactionInfo: jws(PURCHASE) } }) }, log }, res);
    expect(out.status).toBe(400);
  });
});

describe('the dev flag', () => {
  it('decodes without verifying only in local dev, never on Cloud Run whatever the flag says', () => {
    const forged = `${b64u({ alg: 'ES256', x5c: ['forged'] })}.${b64u(PURCHASE)}.not-a-signature`;
    expect(unverifiedAppleJwsAllowed({})).toBe(false);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: 'true' })).toBe(true);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: 'true', K_SERVICE: 'billing' })).toBe(false);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: '1' })).toBe(false);

    process.env.APPLE_JWS_TRUST_UNVERIFIED = 'true';
    delete process.env.K_SERVICE;
    expect(verifyAndDecodeJws(forged)).toMatchObject({ originalTransactionId: '2000000123456789' });
    process.env.K_SERVICE = 'billing';
    expect(refused(() => verifyAndDecodeJws(forged)).status).toBe(400);
  });

  it('no infrastructure or workflow sets the dev flag', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.name === 'node_modules' || entry.name === '.terraform') continue;
        if (entry.isDirectory()) walk(p);
        else if (/\.(tf|tfvars|ya?ml|json|sh)$/.test(entry.name) && fs.readFileSync(p, 'utf8').includes('APPLE_JWS_TRUST_UNVERIFIED')) hits.push(p);
      }
    };
    for (const d of ['infra', '.github', 'services/billing']) if (fs.existsSync(d)) walk(d);
    expect(hits).toEqual([]);
  });
});
