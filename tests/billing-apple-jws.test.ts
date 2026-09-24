import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error: plain ESM modules, no type declarations
import { verifyAndDecodeJws, verifyStoreKitPurchase, unverifiedAppleJwsAllowed } from '../services/billing/src/lib/apple.js';
// @ts-expect-error: plain ESM module, no type declarations
import { appleWebhookRoute } from '../services/billing/src/webhooks/apple.js';

// Apple JWS verification (the x5c chain + ES256) isn't implemented yet (PR-32).
// Until it is, a decoded-but-unverified JWS must never be trusted: that let any
// signed-in user forge a StoreKit purchase (free Pro) and anyone forge App
// Store notifications.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (payload: unknown) => `${b64({ alg: 'ES256', x5c: ['forged'] })}.${b64(payload)}.not-a-signature`;
const forgedPurchase = forge({
  originalTransactionId: '2000000123456789', productId: 'pro_monthly', expiresDate: Date.parse('2099-01-01'),
});

const saved = { flag: process.env.APPLE_JWS_TRUST_UNVERIFIED, k: process.env.K_SERVICE };
afterEach(() => {
  for (const [key, v] of [['APPLE_JWS_TRUST_UNVERIFIED', saved.flag], ['K_SERVICE', saved.k]] as const) {
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

describe('Apple JWS: fail closed until verification exists', () => {
  it('refuses a forged StoreKit purchase with 503', () => {
    delete process.env.APPLE_JWS_TRUST_UNVERIFIED;
    let err: any;
    try { verifyStoreKitPurchase(forgedPurchase); } catch (e) { err = e; }
    expect(err?.status).toBe(503);
  });

  it('answers a forged App Store notification with 503 and grants nothing', async () => {
    delete process.env.APPLE_JWS_TRUST_UNVERIFIED;
    const out = { status: 0, body: undefined as unknown };
    const res = { status(c: number) { out.status = c; return this; }, json(b: unknown) { out.body = b; return this; } };
    const noop = () => {};
    const log = { warn: noop, info: noop, error: noop, child: () => log };
    await appleWebhookRoute(
      { body: { signedPayload: forge({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: forgedPurchase } }) }, log },
      res,
    );
    expect(out.status).toBe(503);
  });

  it('decodes only with the dev flag, and never on Cloud Run whatever the flag says', () => {
    expect(unverifiedAppleJwsAllowed({})).toBe(false);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: 'true' })).toBe(true);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: 'true', K_SERVICE: 'billing' })).toBe(false);
    expect(unverifiedAppleJwsAllowed({ APPLE_JWS_TRUST_UNVERIFIED: '1' })).toBe(false);

    process.env.APPLE_JWS_TRUST_UNVERIFIED = 'true';
    delete process.env.K_SERVICE;
    expect(verifyAndDecodeJws(forgedPurchase)).toMatchObject({ originalTransactionId: '2000000123456789' });
    process.env.K_SERVICE = 'billing';
    expect(() => verifyAndDecodeJws(forgedPurchase)).toThrow(/verification_unavailable/);
  });

  it('no infrastructure or workflow sets the dev flag', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === 'node_modules' || name === '.terraform') continue;
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.(tf|tfvars|ya?ml|json|sh)$/.test(name) && fs.readFileSync(p, 'utf8').includes('APPLE_JWS_TRUST_UNVERIFIED')) hits.push(p);
      }
    };
    for (const d of ['infra', '.github', 'services/billing']) if (fs.existsSync(d)) walk(d);
    expect(hits).toEqual([]);
  });
});
