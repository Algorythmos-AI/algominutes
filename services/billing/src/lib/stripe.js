// Stripe client + webhook signature verification (A9.5, web rail).
//
// The secret key and webhook signing secret come from the environment
// (Secret Manager in prod) — NEVER hardcoded. The client is constructed lazily
// so the module loads (and `node --check` / unit wiring passes) without a key
// present; a missing key surfaces as a clear 503 at call time, not an import
// crash.

import Stripe from 'stripe';

let _stripe = null;

/**
 * Lazily construct the Stripe SDK client.
 * TODO(A11): STRIPE_SECRET_KEY is provisioned in Secret Manager and injected as
 * an env var on the Cloud Run revision; verify against live Stripe.
 */
export function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('stripe_secret_key_missing');
    err.status = 503;
    throw err;
  }
  _stripe = new Stripe(key, {
    apiVersion: process.env.STRIPE_API_VERSION || '2024-06-20',
  });
  return _stripe;
}

/**
 * Verify the `Stripe-Signature` header against the raw request body and the
 * webhook signing secret, returning the typed event. Throws (400/503) on a
 * missing secret or a bad signature — an unverified webhook is never trusted.
 * TODO(A11): STRIPE_WEBHOOK_SECRET from Secret Manager; verify against live Stripe.
 */
export function constructStripeEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('stripe_webhook_secret_missing');
    err.status = 503;
    throw err;
  }
  // stripe.webhooks.constructEvent throws on signature mismatch; the caller
  // maps that to a 400. It REQUIRES the exact received bytes, which is why the
  // webhook route is mounted with express.raw (see app.js).
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}
