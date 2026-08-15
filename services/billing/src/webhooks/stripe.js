// POST /webhooks/stripe (PUBLIC, signature-verified, NO Firebase auth) — A9.5.
//
// The Stripe rail's server-of-record. The signed webhook IS the credential; we
// verify `Stripe-Signature` against the raw body before trusting a single byte.
// Then we drive the entitlement state machine through the repo:
//
//   checkout.session.completed   → grant (first activation; carries uid)
//   customer.subscription.updated → renew / grace / cancellation reflect
//   customer.subscription.deleted → cancellation (keep period end = grace)
//   invoice.paid                 → renewal
//   invoice.payment_failed       → billing retry / grace period (past_due)
//   charge.refunded              → refund (revoke immediately)
//
// uid resolution: checkout.session.completed is the ONE event that carries the
// uid directly (client_reference_id / metadata, set at checkout) — the sub row
// may not exist yet. EVERY other event resolves uid from the repo via
// findUidByRailId({ stripe: subscriptionId }) then falling back to
// { stripeCustomer: customerId }.

import {
  activateSubscription,
  setSubscriptionStatus,
  findUidByRailId,
  trackEvent,
} from '@algominutes/db';

import { getStripe, constructStripeEvent } from '../lib/stripe.js';
import { planFromStripePriceId } from '../lib/plans.js';

/** Resolve uid for a non-checkout event from the rail ids we stored. */
async function resolveUid({ subscriptionId, customerId }) {
  if (subscriptionId) {
    const bySub = await findUidByRailId({ stripe: subscriptionId });
    if (bySub) return bySub;
  }
  if (customerId) {
    const byCustomer = await findUidByRailId({ stripeCustomer: customerId });
    if (byCustomer) return byCustomer;
  }
  return null;
}

/** Epoch seconds → ISO, or null. */
function isoFromUnix(seconds) {
  return seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
}

/** Pull plan + currentPeriodEnd off a Stripe Subscription object. */
function planAndPeriod(subscription) {
  const priceId = subscription?.items?.data?.[0]?.price?.id || null;
  const { plan } = planFromStripePriceId(priceId);
  return { plan, currentPeriodEnd: isoFromUnix(subscription?.current_period_end) };
}

export async function stripeWebhookRoute(req, res) {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing signature' });
  }

  let event;
  try {
    // req.body is the raw Buffer (express.raw), required for signature checking.
    event = constructStripeEvent(req.body, signature);
  } catch (err) {
    // A bad signature is a rejected webhook, not a server fault — 400, no retry.
    req.log.warn({ err, event: 'stripe_signature_invalid' }, 'stripe_signature_invalid');
    const status = err?.status === 503 ? 503 : 400;
    return res.status(status).json({ error: 'Invalid signature' });
  }

  const log = req.log.child({ rail: 'stripe', stripeEventType: event.type, stripeEventId: event.id });
  const stripe = getStripe();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const uid = session.client_reference_id || session.metadata?.uid || null;
      const subscriptionId = session.subscription || null;
      const customerId = session.customer || null;
      if (!uid || !subscriptionId) {
        log.error({ uid, subscriptionId, event: 'stripe_checkout_incomplete' }, 'stripe_checkout_incomplete');
        break;
      }
      // Retrieve the subscription to read the price (plan) + current_period_end.
      // TODO(A11): verify against live Stripe.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const { plan, currentPeriodEnd } = planAndPeriod(subscription);
      if (!currentPeriodEnd) {
        log.error({ uid, subscriptionId, event: 'stripe_no_period_end' }, 'stripe_no_period_end');
        break;
      }
      await activateSubscription({
        uid,
        rail: 'stripe',
        plan,
        currentPeriodEnd,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
      });
      await trackEvent({ uid, event: 'purchase', props: { rail: 'stripe', plan } });
      log.info({ uid, subscriptionId, plan, currentPeriodEnd, event: 'stripe_activated' }, 'stripe_activated');
      break;
    }

    case 'invoice.paid': {
      // Renewal (or first invoice). Re-grant with the fresh period end.
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription || null;
      const customerId = invoice.customer || null;
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid || !subscriptionId) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const { plan, currentPeriodEnd } = planAndPeriod(subscription);
      if (!currentPeriodEnd) break;
      await activateSubscription({
        uid,
        rail: 'stripe',
        plan,
        currentPeriodEnd,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
      });
      log.info({ uid, subscriptionId, currentPeriodEnd, event: 'stripe_renewed' }, 'stripe_renewed');
      break;
    }

    case 'invoice.payment_failed': {
      // Dunning: billing retry / grace period. Keep current_period_end so
      // deriveState leaves the user active until it actually lapses.
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription || null;
      const customerId = invoice.customer || null;
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      await setSubscriptionStatus(uid, 'past_due');
      log.info({ uid, subscriptionId, event: 'stripe_past_due' }, 'stripe_past_due');
      break;
    }

    case 'customer.subscription.updated': {
      // Reflects status changes: active (grace resolved), past_due, canceled at
      // period end, etc. Mirror the status; keep the period end for grace.
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      const customerId = subscription.customer || null;
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      const { plan, currentPeriodEnd } = planAndPeriod(subscription);
      const status = subscription.status; // active | past_due | canceled | unpaid | trialing | ...
      if (status === 'active' && currentPeriodEnd) {
        await activateSubscription({
          uid,
          rail: 'stripe',
          plan,
          currentPeriodEnd,
          stripeSubscriptionId: subscriptionId,
          stripeCustomerId: customerId,
        });
      } else {
        await setSubscriptionStatus(uid, status, currentPeriodEnd);
      }
      log.info({ uid, subscriptionId, status, currentPeriodEnd, event: 'stripe_updated' }, 'stripe_updated');
      break;
    }

    case 'customer.subscription.deleted': {
      // Cancellation. Keep current_period_end (grace) — deriveState flips to
      // free_floor once it passes.
      const subscription = event.data.object;
      const subscriptionId = subscription.id;
      const customerId = subscription.customer || null;
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      await setSubscriptionStatus(uid, 'canceled', isoFromUnix(subscription.current_period_end));
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'stripe' } });
      log.info({ uid, subscriptionId, event: 'stripe_canceled' }, 'stripe_canceled');
      break;
    }

    case 'charge.refunded': {
      // Refund. Revoke entitlement immediately (period end = now).
      const charge = event.data.object;
      const customerId = charge.customer || null;
      const uid = await resolveUid({ customerId });
      if (!uid) {
        log.warn({ customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      await setSubscriptionStatus(uid, 'refunded', new Date().toISOString());
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'stripe', reason: 'refund' } });
      log.info({ uid, event: 'stripe_refunded' }, 'stripe_refunded');
      break;
    }

    default:
      // Unhandled event types are acknowledged, not errored — Stripe sends many
      // we don't act on, and a non-2xx would trigger pointless retries.
      log.info({ event: 'stripe_event_ignored' }, 'stripe_event_ignored');
      break;
  }

  // Ack so Stripe stops retrying. Handler errors above throw → 500 (retry).
  return res.status(200).json({ received: true });
}
