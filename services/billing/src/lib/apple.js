// Apple StoreKit 2 / App Store Server API verification (A9.4/A9.5, iOS rail).
//
// StoreKit 2 hands the client a JWS-signed transaction (`jwsRepresentation`);
// App Store Server Notifications V2 deliver a JWS `signedPayload`. Both are
// JWS (header.payload.signature, base64url) signed by Apple with an x5c cert
// chain in the JWS header. The DURABLE id we key entitlement on is
// `originalTransactionId`.
//
// Every JWS is verified here (plan PR-32), the way Apple's App Store Server
// Library does it offline:
//   1. the header's alg is ES256 and its x5c holds the leaf and intermediate;
//   2. the chain leads to Apple Root CA - G3, pinned in certs/AppleRootCA-G3.cer, Apple's DER file (never the root
//      the token brings: anyone can put a root in a header);
//   3. each certificate is a CA or not as it should be, carries Apple's marker
//      extension (leaf 1.2.840.113635.100.6.11.1, intermediate
//      1.2.840.113635.100.6.2.1), and is valid at the payload's signedDate;
//   4. the leaf's ES256 signature covers the header and payload.
// Callers then check the bundle id (assertOurApp). Revocation (OCSP) isn't
// checked: Apple's library makes that an online option too.
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';

/** Apple Root CA - G3's SHA-256 fingerprint, as Apple publishes it (apple.com/certificateauthority). */
export const APPLE_ROOT_G3_SHA256 = '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
/** The app whose purchases and notifications this server accepts. */
export const APP_BUNDLE_ID = 'com.algorythmos.algominutes';

const invalid = (why) => Object.assign(new Error(`apple_jws_invalid: ${why}`), { status: 400 });

let pinnedRoot = null;
/** The pinned root, checked against Apple's fingerprint; a missing or changed file fails closed (503). */
export function appleRootCA() {
  if (pinnedRoot) return pinnedRoot;
  let root;
  try {
    root = new X509Certificate(fs.readFileSync(new URL('./certs/AppleRootCA-G3.cer', import.meta.url)));
  } catch (err) {
    throw Object.assign(new Error('apple_root_ca_unavailable', { cause: err }), { status: 503 });
  }
  if (root.fingerprint256 !== APPLE_ROOT_G3_SHA256) throw Object.assign(new Error('apple_root_ca_mismatch'), { status: 503 });
  pinnedRoot = root;
  return root;
}

/** An OID as DER bytes (tag, length, value): how it appears in a certificate's extensions. */
function oidDer(oid) {
  const [a, b, ...rest] = oid.split('.').map(Number);
  const body = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) bytes.unshift((v & 0x7f) | 0x80);
    body.push(...bytes);
  }
  return Buffer.from([0x06, body.length, ...body]);
}
const LEAF_MARKER = oidDer('1.2.840.113635.100.6.11.1');
const INTERMEDIATE_MARKER = oidDer('1.2.840.113635.100.6.2.1');
export const _oidDer = oidDer;

function certificate(b64, which) {
  try {
    return new X509Certificate(Buffer.from(String(b64), 'base64'));
  } catch {
    // silent-catch-ok: rethrown as the 400 it is; the certificate came from the caller
    throw invalid(`${which} certificate unreadable`);
  }
}

const validAt = (cert, t) => Date.parse(cert.validFrom) <= t && t <= Date.parse(cert.validTo);

/**
 * Verifies an Apple-signed JWS and returns its header and payload; throws 400
 * for anything Apple didn't sign. `root` and `now` are for tests.
 */
export function verifyAppleJws(jws, { root = appleRootCA(), now = Date.now() } = {}) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) throw invalid('not a JWS');
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    // silent-catch-ok: rethrown as the 400 it is
    throw invalid('unreadable header or payload');
  }
  if (header?.alg !== 'ES256') throw invalid('alg is not ES256');
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) throw invalid('no certificate chain');
  const leaf = certificate(x5c[0], 'leaf');
  const intermediate = certificate(x5c[1], 'intermediate');
  if (x5c.length > 2 && certificate(x5c[2], 'root').fingerprint256 !== root.fingerprint256) throw invalid('not Apple’s root');
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) throw invalid('intermediate not issued by Apple’s root');
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) throw invalid('leaf not issued by the intermediate');
  if (!intermediate.ca || leaf.ca) throw invalid('certificate roles');
  if (!intermediate.raw.includes(INTERMEDIATE_MARKER) || !leaf.raw.includes(LEAF_MARKER)) throw invalid('not an App Store certificate');
  // As Apple's library does offline: valid when Apple signed it (a notification may be retried days later).
  const at = Number.isFinite(payload?.signedDate) ? payload.signedDate : now;
  if (![leaf, intermediate, root].every((c) => validAt(c, at))) throw invalid('certificate not valid at signedDate');
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== 64 || !verifySignature('sha256', signed, { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw invalid('bad signature');
  }
  return { header, payload };
}

/** Refuses a purchase or notification for any app but ours (400). */
export function assertOurApp(bundleId, expected = APP_BUNDLE_ID) {
  if (bundleId !== expected) throw invalid(`bundle id ${JSON.stringify(String(bundleId ?? '')).slice(0, 80)} is not ${expected}`);
}

/**
 * Decode a JWS without verifying its signature. Returns the parsed header and
 * payload. Throws 400 on a malformed token.
 */
export function decodeJws(jws) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) {
    const err = new Error('apple_jws_malformed');
    err.status = 400;
    throw err;
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return { header, payload };
}

/**
 * The environment may trust a decoded-but-unverified JWS only for local
 * development and tests: APPLE_JWS_TRUST_UNVERIFIED=true, and never on Cloud
 * Run (K_SERVICE is set on every deployed revision), whatever the flag says.
 */
export function unverifiedAppleJwsAllowed(env = process.env) {
  return env.APPLE_JWS_TRUST_UNVERIFIED === 'true' && !env.K_SERVICE;
}

/**
 * Verify + decode a JWS: the one place callers get a payload from, so none
 * decodes a JWS itself. Apple's signature is always checked (verifyAppleJws),
 * except where unverifiedAppleJwsAllowed() (local dev and tests, never Cloud
 * Run) restores decode-only.
 */
export function verifyAndDecodeJws(jws, opts) {
  if (unverifiedAppleJwsAllowed()) return decodeJws(jws).payload;
  return verifyAppleJws(jws, opts).payload;
}

/**
 * An App Store Server Notification, verified whole: the notification JWS and
 * the transaction JWS inside it are each Apple-signed and for our app, or it
 * throws (400; 503 when the pinned root is unavailable). One call, so the
 * webhook never decides anything from a payload before it's verified.
 */
export function verifyAppleNotification(signedPayload, opts) {
  const notification = verifyAndDecodeJws(signedPayload, opts);
  assertOurApp(notification?.data?.bundleId);
  const signedTx = notification?.data?.signedTransactionInfo;
  if (!signedTx) throw invalid('no transaction info');
  const tx = extractTransaction(verifyAndDecodeJws(signedTx, opts));
  assertOurApp(tx.bundleId);
  return { notification, tx };
}

/**
 * Normalise a decoded StoreKit 2 transaction payload (from a client
 * jwsRepresentation OR from a webhook's data.signedTransactionInfo) into the
 * fields the repo needs. `expiresDate` is epoch milliseconds.
 */
export function extractTransaction(payload) {
  const currentPeriodEnd = payload.expiresDate
    ? new Date(Number(payload.expiresDate)).toISOString()
    : null;
  return {
    originalTransactionId: payload.originalTransactionId || payload.transactionId || null,
    productId: payload.productId || null,
    currentPeriodEnd,
    environment: payload.environment || null,
    bundleId: payload.bundleId || null,
    revoked: !!payload.revocationDate,
  };
}

/**
 * Verify a client-submitted StoreKit 2 purchase (POST /v1/purchases/verify).
 * Returns the durable id, plan-bearing productId and currentPeriodEnd.
 */
export function verifyStoreKitPurchase(jwsRepresentation, opts) {
  const tx = extractTransaction(verifyAndDecodeJws(jwsRepresentation, opts));
  assertOurApp(tx.bundleId);
  return tx;
}
