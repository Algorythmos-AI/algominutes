// POST /v1/billing/portal (auth: Firebase ID token → uid) — A9.5, web rail.
//
// Creates a Stripe Billing Portal session so a web subscriber can manage /
// cancel / update payment. Requires a Stripe customer already bound to the uid
// (set at checkout); a user with no web subscription gets a clean 409 rather
// than a Stripe error.
//
// Matches PortalSessionResponse (packages/contracts/src/schemas/billing.ts).

import { getSubscription } from '@algominutes/db';

import { getStripe } from '../lib/stripe.js';

export async function portalRoute(req, res) {
  const uid = req.uid;

  const sub = await getSubscription(uid);
  const customerId = sub?.stripe_customer_id || null;
  if (!customerId) {
    return res.status(409).json({ error: 'No Stripe customer for this account' });
  }

  const stripe = getStripe();

  // TODO(A11): set BILLING_PORTAL_RETURN_URL for the web app.
  const returnUrl = process.env.BILLING_PORTAL_RETURN_URL || 'https://app.algominutes.com/billing';

  // TODO(A11): verify against live Stripe.
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  req.log.info({ uid, sessionId: session.id, event: 'portal_created' }, 'portal_created');
  return res.json({ url: session.url });
}
