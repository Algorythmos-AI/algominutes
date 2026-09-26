// Apple StoreKit 2 / App Store Server API verification (A9.4/A9.5, iOS rail).
//
// StoreKit 2 hands the client a JWS-signed transaction (`jwsRepresentation`);
// App Store Server Notifications V2 deliver a JWS `signedPayload`. Both are
// JWS (header.payload.signature, base64url) signed by Apple with an x5c cert
// chain in the JWS header. The DURABLE id we key entitlement on is
// `originalTransactionId`.
//
// ⚠️ TODO(A4-apple / PR-32): FULL signature verification is not done here, so
// verifyAndDecodeJws REFUSES (503) outside local dev and tests. Before trusting
// any decoded payload, a production server MUST:
//   1. Parse the x5c chain from the JWS header.
//   2. Verify the leaf's ES256 signature over the JWS.
//   3. Validate the chain up to Apple Root CA - G3 (and check expiry/OCSP).
//   4. Confirm the bundle id / environment match this app.
// That needs the iOS Firebase app + Apple's root certs, which do not exist in
// this environment. TODO(A11): verify against live Apple (App Store Server API)
// including a decoded-transaction lookup by originalTransactionId.

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
 * Verify + decode a JWS. This is the ONE place real verification will be
 * wired (plan PR-32: the x5c chain to Apple Root CA - G3 and the ES256
 * signature), so callers never decode a JWS themselves.
 *
 * Until then it FAILS CLOSED with 503. Decoding without verifying let any
 * signed-in user forge a StoreKit transaction (POST /v1/purchases/verify:
 * free Pro with any expiry), and let anyone forge App Store notifications
 * (renew or revoke a real subscriber). Only unverifiedAppleJwsAllowed() (local
 * dev and tests) restores the decode-only behaviour.
 */
export function verifyAndDecodeJws(jws) {
  if (!unverifiedAppleJwsAllowed()) {
    const err = new Error('apple_jws_verification_unavailable');
    err.status = 503;
    throw err;
  }
  const { header, payload } = decodeJws(jws);
  // TODO(A4-apple): verify header.x5c chain to Apple Root CA - G3 + ES256 sig.
  // TODO(A11): verify against live Apple before trusting `payload`.
  void header;
  return payload;
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
    revoked: !!payload.revocationDate,
  };
}

/**
 * Verify a client-submitted StoreKit 2 purchase (POST /v1/purchases/verify).
 * Returns the durable id, plan-bearing productId and currentPeriodEnd.
 */
export function verifyStoreKitPurchase(jwsRepresentation) {
  const payload = verifyAndDecodeJws(jwsRepresentation);
  return extractTransaction(payload);
}
