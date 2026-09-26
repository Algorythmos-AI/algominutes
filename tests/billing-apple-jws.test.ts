import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { X509Certificate, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: plain ESM modules, no type declarations
import { APPLE_ROOT_G3_SHA256, appleRootCA, verifyAndDecodeJws, verifyAppleJws, verifyAppleNotification, verifyStoreKitPurchase, unverifiedAppleJwsAllowed } from '../services/billing/src/lib/apple.js';
// @ts-expect-error: plain ESM module, no type declarations
import { appleWebhookRoute } from '../services/billing/src/webhooks/apple.js';

// Apple's JWS (StoreKit 2 transactions, App Store Server Notifications) is
// trusted only when it chains to Apple Root CA - G3 (plan PR-32). Here a
// throwaway PKI built with openssl stands in for Apple's, passed as `root`, so
// each check can be shown refusing what it should.

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

let dir: string;
const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
const der = (pemFile: string) => new X509Certificate(fs.readFileSync(path.join(dir, pemFile))).raw.toString('base64');

/** A CA or leaf certificate signed by `issuer` (none: self-signed), with the given extensions. */
function cert(name: string, issuer: string | null, ext: string[]) {
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`);
  fs.writeFileSync(path.join(dir, `${name}.ext`), `${ext.join('\n')}\n`);
  if (!issuer) {
    openssl('req', '-x509', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-days', '3650', '-out', `${name}.pem`, '-extensions', 'v3', '-config', writeReqConfig(name, ext));
    return;
  }
  openssl('req', '-new', '-key', `${name}.key`, '-subj', `/CN=${name}`, '-out', `${name}.csr`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-days', '3650', '-extfile', `${name}.ext`, '-out', `${name}.pem`);
}
function writeReqConfig(name: string, ext: string[]) {
  const f = path.join(dir, `${name}.cnf`);
  fs.writeFileSync(f, `[req]\ndistinguished_name=dn\n[dn]\n[v3]\n${ext.join('\n')}\n`);
  return f;
}
const CA = ['basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign'];
const INTERMEDIATE = [...CA, '1.2.840.113635.100.6.2.1=ASN1:NULL'];
const LEAF = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', '1.2.840.113635.100.6.11.1=ASN1:NULL'];

let root: X509Certificate;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-pki-'));
  cert('root', null, CA);
  cert('int', 'root', INTERMEDIATE);
  cert('leaf', 'int', LEAF);
  cert('plainleaf', 'int', ['basicConstraints=critical,CA:FALSE']); // no App Store marker
  cert('other', null, CA); // another root
  cert('otherint', 'other', INTERMEDIATE);
  cert('otherleaf', 'otherint', LEAF);
  root = new X509Certificate(fs.readFileSync(path.join(dir, 'root.pem')));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A JWS signed by `leafName`'s key, carrying the chain `chain` (x5c). */
function jws(payload: unknown, { leafName = 'leaf', chain = ['leaf', 'int', 'root'], alg = 'ES256' } = {}) {
  const head = b64u({ alg, x5c: chain.map((n) => der(`${n}.pem`)) });
  // Signed now, as Apple stamps it: after the certificates were made (a payload may set its own).
  const body = b64u({ signedDate: Date.now(), ...(payload as object) });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: fs.readFileSync(path.join(dir, `${leafName}.key`)), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
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
