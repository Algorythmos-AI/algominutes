// POST /v1/billing/checkout (auth: Firebase ID token → uid) — A9.5, web rail.
//
// Creates a Stripe Checkout session in SUBSCRIPTION mode (card collected at the
// point of conversion, never before — matches the reverse-trial model: no card
// during the trial). We stamp the uid on the session (client_reference_id +
// metadata) so the resulting `checkout.session.completed` webhook can key the
// entitlement to the right account, and we bind the Stripe customer to the uid
// so the portal + renewal webhooks resolve back to it.
//
// Matches CheckoutSessionRequest / CheckoutSessionResponse
// (packages/contracts/src/schemas/billing.ts).

import { getSubscription } from '@algominutes/db';

import { getStripe } from '../lib/stripe.js';
import { productById } from '../lib/plans.js';

export async function checkoutRoute(req, res) {
  const uid = req.uid;
  const { productId } = req.body || {};

  const product = productById(productId);
  if (!product) {
    return res.status(400).json({ error: 'Unknown product' });
  }
  if (!product.stripePriceId) {
    // The Stripe price id is env/config; without it we cannot charge correctly.
    req.log.error({ uid, productId, event: 'stripe_price_unconfigured' }, 'stripe_price_unconfigured');
    // TODO(A11): set STRIPE_PRICE_PRO_MONTHLY / STRIPE_PRICE_PRO_ANNUAL.
    return res.status(503).json({ error: 'Billing not configured' });
  }

  const stripe = getStripe();

  // Reuse an existing Stripe customer for this uid if we already have one, so a
  // returning user does not get a duplicate customer record.
  const existing = await getSubscription(uid);
  const customerId = existing?.stripe_customer_id || null;

  // URLs are config, not secrets.
  // TODO(A11): set BILLING_SUCCESS_URL / BILLING_CANCEL_URL for the web app.
  const successUrl = process.env.BILLING_SUCCESS_URL || 'https://app.algominutes.com/billing/success';
  const cancelUrl = process.env.BILLING_CANCEL_URL || 'https://app.algominutes.com/billing/cancel';

  // TODO(A11): verify against live Stripe (real secret key + price ids).
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: product.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Bind the session to the uid so the completion webhook can resolve it.
    client_reference_id: uid,
    metadata: { uid, productId: product.id, plan: product.plan },
    subscription_data: { metadata: { uid, plan: product.plan } },
    ...(customerId ? { customer: customerId } : {}),
  });

  req.log.info({ uid, productId: product.id, sessionId: session.id, event: 'checkout_created' }, 'checkout_created');
  return res.json({ url: session.url });
}
