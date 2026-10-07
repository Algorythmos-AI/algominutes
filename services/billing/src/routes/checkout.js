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

import { createHash } from 'node:crypto';
import { getSubscription, deriveState } from '@algominutes/db';
import siteUrlModule from '@algominutes/ai/site-url.cjs';

import { getStripe } from '../lib/stripe.js';
import { productById } from '../lib/plans.js';
import { webAppOrigin } from '../lib/return-origin.js';

const { publicSiteUrl } = siteUrlModule;

/** How long two identical checkout requests are the same request. Stripe keeps a key for 24 hours. */
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;

/**
 * One key per buyer, price, return pages and ten-minute window. Everything that goes into the session goes
 * into the key: Stripe refuses a key reused with different parameters. No uid in the clear: it's hashed.
 */
export function checkoutIdempotencyKey({ uid, priceId, successUrl, cancelUrl, customerId }, now = Date.now()) {
  const window = Math.floor(now / CHECKOUT_WINDOW_MS);
  return `checkout_${createHash('sha256').update([uid, priceId, successUrl, cancelUrl, customerId || '', window].join('\n')).digest('hex')}`;
}

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

  const existing = await getSubscription(uid);
  // The pre-purchase check (RELEASE.md PR 26b, BLOCKERS "Cross-rail double-charge race"): a user already
  // paying, on any rail, is never sent to a second checkout. A store's charge can't be refunded from here,
  // so the second purchase must not start. A grant or the trial isn't a subscription and doesn't block.
  // The answer names the rail, so the client can say where to manage it.
  if (existing && deriveState(existing) === 'active') {
    const rail = existing.source || null;
    req.log.warn({ uid, rail, productId: product.id, event: 'checkout_refused_subscribed' }, 'checkout_refused_subscribed');
    return res.status(409).json({ error: 'Already subscribed', rail });
  }

  // Reuse an existing Stripe customer for this uid if we already have one, so a
  // returning user does not get a duplicate customer record.
  const customerId = existing?.stripe_customer_id || null;

  // Back to the web app the buyer came from, when its origin is one we serve
  // (lib/return-origin.js): its success page waits for the webhook and shows the
  // plan. Otherwise the public site's pages, or an override.
  const app = webAppOrigin(req.headers?.origin);
  const successUrl = app ? `${app}/app/billing/success` : process.env.BILLING_SUCCESS_URL || `${publicSiteUrl()}/billing/success`;
  const cancelUrl = app ? `${app}/app/billing/cancel` : process.env.BILLING_CANCEL_URL || `${publicSiteUrl()}/billing/cancel`;

  // TODO(A11): verify against live Stripe (real secret key + price ids).
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      line_items: [{ price: product.stripePriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Bind the session to the uid so the completion webhook can resolve it.
      client_reference_id: uid,
      metadata: { uid, productId: product.id, plan: product.plan },
      subscription_data: { metadata: { uid, plan: product.plan } },
      ...(customerId ? { customer: customerId } : {}),
    },
    // The same buyer asking for the same thing twice (a double click, a retry after a timeout, two tabs)
    // gets the same session, and a session can be paid once (RELEASE.md rev 11, H21).
    { idempotencyKey: checkoutIdempotencyKey({ uid, priceId: product.stripePriceId, successUrl, cancelUrl, customerId }) },
  );

  req.log.info({ uid, productId: product.id, sessionId: session.id, event: 'checkout_created' }, 'checkout_created');
  return res.json({ url: session.url });
}
