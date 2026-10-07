// POST /webhooks/stripe (PUBLIC, signature-verified, NO Firebase auth) — A9.5.
//
// The Stripe rail's server-of-record. The signed webhook IS the credential; we
// verify `Stripe-Signature` against the raw body before trusting a single byte.
// Then we drive the entitlement state machine through the repo:
//
//   checkout.session.completed   → grant (first activation; carries uid)
//   invoice.paid                 → renewal
//   customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed
//                                → the subscription is read back from Stripe, and that is what's written
//   charge.refunded              → a refund of the whole charge revokes immediately; a partial one doesn't
//
// uid resolution: checkout.session.completed is the ONE event that carries the
// uid directly (client_reference_id / metadata, set at checkout) — the sub row
// may not exist yet. EVERY other event resolves uid from the repo via
// findUidByRailId({ stripe: subscriptionId }) then falling back to
// { stripeCustomer: customerId }.

import {
  activateSubscription,
  cancelIfAccountDeleted,
  deriveState,
  getSubscription,
  queueStripeCancellation,
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

/** An id that Stripe gives as a string, or as the expanded object. */
function idOf(ref) {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id || null;
}

/**
 * When a subscription's paid period ends. Stripe moved it: on the subscription itself up to the 2025-02
 * API, on its items from 2025-03 (`items.data[0].current_period_end`). The account's API version decides
 * what a webhook carries, whatever version this service pins for its own calls, so both are read.
 */
function periodEndOf(subscription) {
  return subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end ?? null;
}

/** The subscription an invoice is for: `invoice.subscription`, or under `parent` from the 2025-03 API. */
function subscriptionOfInvoice(invoice) {
  return idOf(invoice?.subscription) || idOf(invoice?.parent?.subscription_details?.subscription);
}

/** Pull plan + currentPeriodEnd off a Stripe Subscription object. */
function planAndPeriod(subscription) {
  const priceId = subscription?.items?.data?.[0]?.price?.id || null;
  const { plan } = planFromStripePriceId(priceId);
  return { plan, currentPeriodEnd: isoFromUnix(periodEndOf(subscription)) };
}

/**
 * The subscription as Stripe has it now (RELEASE.md rev 11, H21). Events arrive late, twice and out of
 * order: a "past due" from before a renewal, replayed after it, used to put a paid account back in
 * arrears. Each event is only a reason to look; what is written is what Stripe says at that moment.
 * Null when Stripe no longer has it: the caller falls back to the event. Stripe unreachable is thrown.
 */
async function currentSubscription(stripe, subscriptionId, log) {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    // Only "Stripe has no such subscription" falls back to the event. A timeout or a 5xx is thrown: the
    // webhook answers 500 and Stripe delivers again, rather than a stale event being written as the state.
    if (err?.code !== 'resource_missing') throw err;
    log.warn({ err, subscriptionId, event: 'stripe_subscription_gone' }, 'stripe_subscription_gone');
    return null;
  }
}

/**
 * Why an event must not change this account, or null when it may. Only a completed checkout puts an account
 * on a subscription; every other event acts only on the subscription the account is on:
 *   - 'other_subscription': the event is about a different Stripe subscription of the same customer (a
 *     duplicate being cancelled, its first invoice, an older one ending);
 *   - 'other_rail': the account now pays through a store, and still carries an old Stripe subscription's id.
 *     That subscription's last events must not overwrite the store's period.
 */
const STORE_RAILS = new Set(['apple_storekit', 'google_play']);
function notThisAccounts(row, subscriptionId) {
  if (!row) return null;
  if (STORE_RAILS.has(row.source)) return 'other_rail';
  if (row.stripe_subscription_id && subscriptionId && row.stripe_subscription_id !== subscriptionId) return 'other_subscription';
  return null;
}

/** Write what Stripe says a subscription is. Returns the status written. */
async function reflect({ uid, subscription, customerId, row }) {
  const { plan, currentPeriodEnd } = planAndPeriod(subscription);
  const status = subscription.status; // active | trialing | past_due | canceled | unpaid | incomplete | ...
  if ((status === 'active' || status === 'trialing') && currentPeriodEnd) {
    await activateSubscription({
      uid,
      rail: 'stripe',
      plan,
      currentPeriodEnd,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId,
    });
    return 'active';
  }
  // Cancelled, in arrears, unpaid: the status changes and the paid period stands (grace).
  await setSubscriptionStatus(uid, status, currentPeriodEnd);
  // Counted when it becomes cancelled, not each time an event says so.
  if (status === 'canceled' && row?.status !== 'canceled') {
    await trackEvent({ uid, event: 'cancellation', props: { rail: 'stripe' } });
  }
  return status;
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
      const subscriptionId = idOf(session.subscription);
      const customerId = idOf(session.customer);
      if (!uid || !subscriptionId) {
        log.error({ uid, userId: uid, subscriptionId, event: 'stripe_checkout_incomplete' }, 'stripe_checkout_incomplete');
        break;
      }
      // Paid for an account deleted meanwhile (RELEASE.md PR 28b): it's cancelled, never activated
      // (activating would fail the deleted user's foreign key, and Stripe would go on charging).
      if (await cancelIfAccountDeleted(uid, subscriptionId, req.traceId)) {
        log.warn({ uid, userId: uid, subscriptionId, event: 'stripe_checkout_after_deletion' }, 'stripe_checkout_after_deletion');
        break;
      }
      // A second subscription for an account that is already paying (RELEASE.md rev 11, H21): two
      // checkouts open at once both pass the pre-purchase check, and the second completion used to
      // replace the first on the row, leaving the first charging with nothing pointing at it. The one the
      // account is on stands; this one is cancelled by the cancel-stripe task. Its first payment is NOT
      // refunded from here: this line is the alert to refund it by hand.
      const paying = await getSubscription(uid);
      if (paying && deriveState(paying) === 'active' && paying.stripe_subscription_id !== subscriptionId) {
        await queueStripeCancellation(subscriptionId, req.traceId);
        log.error(
          { uid, userId: uid, subscriptionId, customerId, onRail: paying.source || null, onSubscriptionId: paying.stripe_subscription_id || null, event: 'stripe_duplicate_subscription' },
          'stripe_duplicate_subscription',
        );
        break;
      }
      // Retrieve the subscription to read the price (plan) + current_period_end.
      // TODO(A11): verify against live Stripe.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const { plan, currentPeriodEnd } = planAndPeriod(subscription);
      if (!currentPeriodEnd) {
        log.error({ uid, userId: uid, subscriptionId, event: 'stripe_no_period_end' }, 'stripe_no_period_end');
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
      log.info({ uid, userId: uid, subscriptionId, plan, currentPeriodEnd, event: 'stripe_activated' }, 'stripe_activated');
      break;
    }

    case 'invoice.paid': {
      // Renewal (or first invoice). Re-grant with the fresh period end.
      const invoice = event.data.object;
      const subscriptionId = subscriptionOfInvoice(invoice);
      const customerId = idOf(invoice.customer);
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid || !subscriptionId) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      // A duplicate's first invoice finds the account by its customer: it must not move the account onto
      // the duplicate (which is then cancelled, leaving the real one charging unseen).
      const invoiceRow = await getSubscription(uid);
      const invoiceNotOurs = notThisAccounts(invoiceRow, subscriptionId);
      if (invoiceNotOurs) {
        log.warn(
          { uid, userId: uid, subscriptionId, onRail: invoiceRow.source || null, onSubscriptionId: invoiceRow.stripe_subscription_id || null, reason: invoiceNotOurs, event: 'stripe_event_not_this_accounts' },
          'stripe_event_not_this_accounts',
        );
        break;
      }
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const { plan, currentPeriodEnd } = planAndPeriod(subscription);
      if (!currentPeriodEnd) {
        log.error({ uid, userId: uid, subscriptionId, event: 'stripe_no_period_end' }, 'stripe_no_period_end');
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
      log.info({ uid, userId: uid, subscriptionId, currentPeriodEnd, event: 'stripe_renewed' }, 'stripe_renewed');
      break;
    }

    case 'invoice.payment_failed':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Each of these says "something changed": a failed payment (dunning), a status change, a
      // cancellation. None is trusted for what the subscription is now; Stripe is asked.
      const object = event.data.object;
      const isInvoice = event.type === 'invoice.payment_failed';
      const subscriptionId = isInvoice ? subscriptionOfInvoice(object) : object.id;
      const customerId = idOf(object.customer);
      const uid = await resolveUid({ subscriptionId, customerId });
      if (!uid) {
        log.warn({ subscriptionId, customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      const row = await getSubscription(uid);
      const notOurs = notThisAccounts(row, subscriptionId);
      if (notOurs) {
        log.warn(
          { uid, userId: uid, subscriptionId, onRail: row.source || null, onSubscriptionId: row.stripe_subscription_id || null, reason: notOurs, event: 'stripe_event_not_this_accounts' },
          'stripe_event_not_this_accounts',
        );
        break;
      }
      // Unreadable: the event's own object is all there is. An invoice carries no subscription state, so
      // a failed payment falls back to what it always meant.
      const subscription = (subscriptionId && (await currentSubscription(stripe, subscriptionId, log)))
        || (isInvoice ? null : object);
      if (!subscription) {
        await setSubscriptionStatus(uid, 'past_due');
        log.info({ uid, userId: uid, subscriptionId, event: 'stripe_past_due' }, 'stripe_past_due');
        break;
      }
      const status = await reflect({ uid, subscription, customerId, row });
      log.info({ uid, userId: uid, subscriptionId, status, event: 'stripe_reflected' }, 'stripe_reflected');
      break;
    }

    case 'charge.refunded': {
      // Refund. Revoke entitlement immediately (period end = now).
      const charge = event.data.object;
      const customerId = idOf(charge.customer);
      const uid = await resolveUid({ customerId });
      if (!uid) {
        log.warn({ customerId, event: 'stripe_uid_unresolved' }, 'stripe_uid_unresolved');
        break;
      }
      // Only a refund of the whole charge ends Pro (RELEASE.md rev 11, H21). A partial one (a goodwill
      // credit, a prorated plan change) took it away too. Stripe sends this event for every refund of a
      // charge, with the running total: `refunded` is true once nothing is left.
      const amount = Number(charge.amount);
      const amountRefunded = Number(charge.amount_refunded);
      const whole = charge.refunded === true || (amount > 0 && amountRefunded >= amount);
      if (!whole) {
        log.info({ uid, userId: uid, amount, amountRefunded, event: 'stripe_partial_refund' }, 'stripe_partial_refund');
        break;
      }
      // Delivered at least once: a replay must not move the end again or count a second cancellation.
      const current = await getSubscription(uid);
      if (current?.status === 'refunded') {
        log.info({ uid, userId: uid, event: 'stripe_refund_replayed' }, 'stripe_refund_replayed');
        break;
      }
      // The account is found by the charge's customer, and a customer can have other charges: a cancelled
      // duplicate's first payment (refunded by hand, as stripe_duplicate_subscription asks), or an old
      // subscription's. Only a refund of the subscription the account is on ends Pro. The charge names its
      // invoice, and the invoice its subscription.
      const invoiceId = idOf(charge.invoice);
      const invoice = invoiceId ? await stripe.invoices.retrieve(invoiceId) : null;
      const refundedSubscriptionId = invoice ? subscriptionOfInvoice(invoice) : null;
      const refundNotOurs = refundedSubscriptionId ? notThisAccounts(current, refundedSubscriptionId) : 'unattributed';
      if (refundNotOurs) {
        // 'unattributed': the charge carries no invoice (a one-off charge, or an API version that dropped
        // the field). Pro is kept, loudly: wrongly ending a paid subscription is worse than keeping one to
        // its period end, and whoever refunds a subscription in full cancels it too, which does arrive.
        const line = { uid, userId: uid, chargeId: charge.id || null, refundedSubscriptionId, onSubscriptionId: current?.stripe_subscription_id || null, reason: refundNotOurs, event: 'stripe_refund_not_this_accounts' };
        if (refundNotOurs === 'unattributed') log.error(line, 'stripe_refund_not_this_accounts');
        else log.warn(line, 'stripe_refund_not_this_accounts');
        break;
      }
      await setSubscriptionStatus(uid, 'refunded', new Date().toISOString());
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'stripe', reason: 'refund' } });
      log.info({ uid, userId: uid, event: 'stripe_refunded' }, 'stripe_refunded');
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
