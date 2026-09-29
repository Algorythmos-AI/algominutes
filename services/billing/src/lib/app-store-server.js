// Apple's App Store Server API (RELEASE.md PR 26): what a subscription's state is now, as Apple knows it,
// so a notification that never arrived, or arrived out of order, can't leave an entitlement wrong
// (tasks/reconcile-apple.js).
//
// developer.apple.com, "Get All Subscription Statuses": GET /inApps/v1/subscriptions/{transactionId}, with
// an ES256 JWT ({ alg, kid, typ: 'JWT' } / { iss: issuer id, iat, exp, aud: 'appstoreconnect-v1', bid }).
// Production is asked first, then the sandbox when production doesn't know the transaction: TestFlight and
// App Review buy in the sandbox against the production server (docs/DECISIONS.md, "Real IAP in sandbox").
//
// Apple's answer is trusted no more than a notification is: every signedTransactionInfo and
// signedRenewalInfo in it is verified to Apple Root CA - G3 (lib/apple.js), must be for our app, and must
// be the subscription asked about, from the environment asked.
import crypto from 'node:crypto';
import secretReaderModule from '@algominutes/ai/secret-reader.cjs';
import { APP_BUNDLE_ID, assertOurApp, extractTransaction, verifyAndDecodeJws } from './apple.js';

const { createSecretReader } = secretReaderModule;

/** The App Store Connect in-app purchase key (.p8 PEM) in Secret Manager: the owner adds it as a version. */
export const APP_STORE_SERVER_SECRET = 'app-store-server-key';

export const HOSTS = {
  Production: 'https://api.storekit.apple.com',
  Sandbox: 'https://api.storekit-sandbox.apple.com',
};
const JWT_TTL_S = 20 * 60; // Apple accepts up to 60 minutes
const JWT_REUSE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Apple's subscription status codes ("status", Get All Subscription Statuses). */
export const STATUS = { 1: 'active', 2: 'expired', 3: 'billing_retry', 4: 'grace', 5: 'revoked' };

export class AppStoreServerError extends Error {
  constructor(message, { status = 0, errorCode = null, code = null } = {}) {
    super(message);
    this.name = 'AppStoreServerError';
    this.status = status;
    // Apple's numeric errorCode (4040010 TransactionIdNotFoundError, ...): a fixed number, never its message.
    this.errorCode = errorCode;
    // What failed underneath, as a fixed identifier (ENOTFOUND, TimeoutError), never a message.
    this.code = code;
  }

  /** Our key, issuer or bundle id is wrong (401, 403): no retry fixes it, a person must. */
  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** The ES256 bearer token the App Store Server API expects. */
export function appStoreServerJwt({ issuerId, keyId, privateKeyPem, bundleId = APP_BUNDLE_ID, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  const signing = `${b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${b64url({ iss: issuerId, iat, exp: iat + JWT_TTL_S, aud: 'appstoreconnect-v1', bid: bundleId })}`;
  const signature = crypto.sign('sha256', Buffer.from(signing), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${signing}.${signature.toString('base64url')}`;
}

const invalid = (why) => Object.assign(new Error(`app_store_answer_invalid: ${why}`), { status: 502 });

/**
 * A client for one App Store Connect key. `verifyOpts` passes through to the JWS verification (tests
 * give it their own root).
 */
export function createAppStoreServerClient({
  issuerId, keyId, privateKeyPem, bundleId = APP_BUNDLE_ID, fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, verifyOpts,
}) {
  if (!issuerId || !keyId || !privateKeyPem) throw new Error('app-store-server: issuerId, keyId and privateKeyPem are required');
  let jwt = null;
  let jwtAt = 0;
  const bearer = () => {
    if (!jwt || now() - jwtAt > JWT_REUSE_MS) {
      jwt = appStoreServerJwt({ issuerId, keyId, privateKeyPem, bundleId, nowMs: now() });
      jwtAt = now();
    }
    return jwt;
  };

  async function get(environment, path) {
    // Signed first, outside the network's try: a bad key is its own error, not "network error".
    const token = bearer();
    let res;
    let text;
    try {
      res = await fetchImpl(`${HOSTS[environment]}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const code = String(err?.cause?.code || err?.code || err?.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || null;
      throw new AppStoreServerError(`app store ${environment}: ${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}`, { code });
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      // silent-catch-ok: an error answer that isn't JSON still throws below (HTTP status only); an OK one throws here.
      // Not JSON.parse's message: it would quote the body.
      if (!(err instanceof SyntaxError)) throw err;
      if (res.ok) throw new AppStoreServerError(`app store ${environment}: answer is not JSON`, { status: res.status });
    }
    if (!res.ok) {
      const errorCode = Number.isInteger(body?.errorCode) ? body.errorCode : null;
      throw new AppStoreServerError(`app store ${environment}: HTTP ${res.status}${errorCode ? ` ${errorCode}` : ''}`, { status: res.status, errorCode });
    }
    return body;
  }

  /** The subscription in Apple's answer, verified; null when the answer doesn't hold it. */
  function read(environment, body, originalTransactionId) {
    assertOurApp(body?.bundleId, bundleId);
    if (body?.environment !== environment) throw invalid(`asked ${environment}, answered ${JSON.stringify(String(body?.environment ?? '')).slice(0, 40)}`);
    const last = (body.data || [])
      .flatMap((group) => group?.lastTransactions || [])
      .find((t) => t?.originalTransactionId === originalTransactionId);
    if (!last) return null;
    if (!last.signedTransactionInfo) throw invalid('no transaction info');
    const tx = extractTransaction(verifyAndDecodeJws(last.signedTransactionInfo, verifyOpts));
    assertOurApp(tx.bundleId, bundleId);
    if (tx.originalTransactionId !== originalTransactionId) throw invalid('another subscription’s transaction');
    if (tx.environment !== environment) throw invalid(`a ${tx.environment} transaction from ${environment}`);
    let graceEnd = null;
    if (last.signedRenewalInfo) {
      const renewal = verifyAndDecodeJws(last.signedRenewalInfo, verifyOpts);
      if (renewal?.originalTransactionId !== originalTransactionId) throw invalid('another subscription’s renewal info');
      if (renewal.gracePeriodExpiresDate) graceEnd = new Date(Number(renewal.gracePeriodExpiresDate)).toISOString();
    }
    return {
      environment,
      status: STATUS[last.status] || 'unknown',
      statusCode: last.status ?? null,
      productId: tx.productId,
      currentPeriodEnd: tx.currentPeriodEnd,
      revoked: tx.revoked,
      graceEnd,
    };
  }

  return {
    /**
     * The subscription `originalTransactionId` started, as Apple knows it now: { environment, status
     * ('active' | 'expired' | 'billing_retry' | 'grace' | 'revoked' | 'unknown'), statusCode, productId,
     * currentPeriodEnd, revoked, graceEnd }, or null when neither environment knows it. Throws
     * AppStoreServerError when Apple can't be asked, and a 400/502 for an answer that isn't Apple's or ours.
     */
    async subscriptionStatus(originalTransactionId) {
      if (!/^\d{1,32}$/.test(String(originalTransactionId || ''))) throw new AppStoreServerError('app store: not a transaction id', { status: 400 });
      const path = `/inApps/v1/subscriptions/${originalTransactionId}`;
      for (const environment of ['Production', 'Sandbox']) {
        let body;
        try {
          body = await get(environment, path);
        } catch (err) {
          // silent-catch-ok: a 404 is Apple saying the transaction isn't this environment's; the next is asked,
          // and neither knowing it answers null. Anything else is thrown.
          if (err instanceof AppStoreServerError && err.status === 404) continue;
          throw err;
        }
        return read(environment, body, String(originalTransactionId));
      }
      return null;
    },
  };
}

/**
 * This environment's client, from its env (APPLE_ISSUER_ID, APPLE_KEY_ID) and the key in Secret Manager,
 * read at run time so a deploy never waits for it: { client }, or { missing: 'env' | 'secret' } until the
 * owner has set it up. A rotated key makes a new client.
 */
export function createAppStoreServer({
  env = process.env,
  readSecret = createSecretReader({ projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT }),
  createClient = createAppStoreServerClient,
} = {}) {
  let client = null;
  let clientPem = null;
  return async function appStoreServer(log) {
    if (!env.APPLE_ISSUER_ID || !env.APPLE_KEY_ID) return { missing: 'env' };
    const pem = await readSecret(APP_STORE_SERVER_SECRET, { log });
    if (!pem) return { missing: 'secret' };
    if (!client || clientPem !== pem) {
      client = createClient({ issuerId: env.APPLE_ISSUER_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: pem });
      clientPem = pem;
    }
    return { client };
  };
}
