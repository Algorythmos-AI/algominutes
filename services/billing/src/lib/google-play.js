// Google Play Developer API verification (A9.4/A9.5, Android rail).
//
// The Android Play Billing CLIENT is B2 (see README). The SERVER side lives
// here: given a `purchaseToken` + `productId`, we verify server-side against the
// Play Developer API (`purchases.subscriptions.get`) and read the durable state
// (expiry, payment/cancel state). The DURABLE id we key entitlement on is the
// `purchaseToken` itself.
//
// Auth is Application Default Credentials with the androidpublisher scope; the
// Cloud Run runtime service account must be linked in the Play Console.
// TODO(A11): grant the runtime SA Play Developer access, enable the API, and
// verify against live Google.

import { google } from 'googleapis';

let _publisher = null;

async function androidPublisher() {
  if (_publisher) return _publisher;
  // A stand-in Play API for tests: PLAY_API_ROOT_URL is unset in every deployed
  // environment, where the client uses ADC against androidpublisher.googleapis.com.
  // With it set, a static token stands in, so no real credential is looked up.
  const rootUrl = process.env.PLAY_API_ROOT_URL;
  let auth;
  if (rootUrl) {
    auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'stand-in' });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  }
  _publisher = google.androidpublisher({ version: 'v3', auth, ...(rootUrl ? { rootUrl } : {}) });
  return _publisher;
}

/** The Android app package name (env-driven; not a secret). */
export function playPackageName() {
  // TODO(A11): set PLAY_PACKAGE_NAME on the Cloud Run revision.
  return process.env.PLAY_PACKAGE_NAME || 'app.algominutes';
}

/**
 * Verify a subscription purchase token against Play. Returns the normalised
 * durable id + currentPeriodEnd + raw state used to decide activate/setStatus.
 * TODO(A11): verify against live Google — purchases.subscriptions.get.
 */
export async function verifyPlaySubscription({ productId, purchaseToken }) {
  const pub = await androidPublisher();
  const { data } = await pub.purchases.subscriptions.get({
    packageName: playPackageName(),
    subscriptionId: productId,
    token: purchaseToken,
  });
  const currentPeriodEnd = data.expiryTimeMillis
    ? new Date(Number(data.expiryTimeMillis)).toISOString()
    : null;
  return {
    purchaseToken,
    productId,
    currentPeriodEnd,
    // paymentState: 0 pending, 1 received, 2 free trial, 3 pending deferred.
    paymentState: typeof data.paymentState === 'number' ? data.paymentState : null,
    // cancelReason present ⇒ user/system cancelled (still valid until expiry).
    cancelReason: typeof data.cancelReason === 'number' ? data.cancelReason : null,
    // 0 active/expired, 1 in grace period, 2 on hold, 3 paused, 4 pending.
    acknowledgementState: data.acknowledgementState ?? null,
    raw: data,
  };
}

// Play Real-Time Developer Notification subscription notification types.
// https://developer.android.com/google/play/billing/rtdn-reference
export const PLAY_NOTIFICATION = {
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
};
