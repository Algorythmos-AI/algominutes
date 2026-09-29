// POST /tasks/cancel-stripe (Cloud Scheduler, every 15 minutes, OIDC as run-jobs; RELEASE.md PR 28b).
//
// A deleted account's Stripe subscription would go on charging: account deletion removes the subscriptions
// row, and Stripe knows nothing of it. The deletion (or a checkout webhook arriving after it) records the
// subscription in stripe_cancellations; this cancels each with Stripe: immediately, with no proration and
// no final invoice. One already over (canceled, expired, or gone from Stripe) is simply marked done.
//
// Each is its own try: a failure is counted and backed off (15 minutes, doubling, at most a day), and after
// STRIPE_CANCEL_STUCK_ATTEMPTS it's logged stuck on each attempt (daily by then) until a person acts. With nothing due it
// never calls Stripe; with something due and no Stripe key, it says so (an alert: charges continue).
import { STRIPE_CANCEL_STUCK_ATTEMPTS } from '@algominutes/db';

const BATCH = 50;
// Stripe's status for a subscription that charges no more.
const OVER = new Set(['canceled', 'incomplete_expired']);

/** A Stripe error as a short fixed code (its code or type), never its message. */
const reasonOf = (err) => String(err?.code || err?.type || err?.name || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'error';

/**
 * The route. `repo` is @algominutes/db's listDueStripeCancellations, markStripeCancelled and
 * markStripeCancelFailed; `getStripe` answers the client or throws (503) with no key.
 */
export function createCancelStripe({ repo, getStripe, batch = BATCH }) {
  return async function cancelStripe(req, res) {
    let due;
    try {
      due = await repo.listDueStripeCancellations(batch);
    } catch (err) {
      req.log.error({ err, event: 'stripe_cancel_run_failed' }, 'stripe_cancel_run_failed');
      return res.status(500).json({ error: 'Cancel run failed' });
    }
    if (!due.length) return res.status(200).json({ due: 0 });
    let stripe;
    try {
      stripe = getStripe();
    } catch (err) {
      // Deleted accounts' subscriptions are waiting, and nothing can cancel them: charges continue.
      req.log.error({ err, due: due.length, event: 'stripe_cancel_not_configured' }, 'stripe_cancel_not_configured');
      return res.status(500).json({ error: 'Stripe not configured', due: due.length });
    }
    const counts = { due: due.length, cancelled: 0, alreadyOver: 0, failed: 0 };
    for (const c of due) {
      // The deletion's traceId, so one account's deletion is followable to its cancellation (CLAUDE.md: across
      // every async hop); this run's is taskTraceId.
      const log = req.log.child({ traceId: c.traceId || req.traceId, taskTraceId: req.traceId, stripeSubscriptionId: c.stripeSubscriptionId });
      try {
        let over = false;
        try {
          const sub = await stripe.subscriptions.retrieve(c.stripeSubscriptionId);
          over = OVER.has(sub?.status);
        } catch (err) {
          // silent-catch-ok: Stripe doesn't know it (deleted, or another mode's id), so nothing is charging and
          // it's marked done below; anything else is thrown to the attempt's own catch, which logs it
          if (err?.code !== 'resource_missing') throw err;
          over = true;
        }
        if (!over) await stripe.subscriptions.cancel(c.stripeSubscriptionId, { prorate: false, invoice_now: false });
        await repo.markStripeCancelled(c.stripeSubscriptionId);
        if (over) counts.alreadyOver += 1;
        else counts.cancelled += 1;
        log.info({ alreadyOver: over, event: 'stripe_subscription_cancelled' }, 'stripe_subscription_cancelled');
      } catch (err) {
        counts.failed += 1;
        const reason = reasonOf(err);
        let attempts = c.attempts + 1;
        try {
          attempts = await repo.markStripeCancelFailed(c.stripeSubscriptionId, reason);
        } catch (markErr) {
          log.error({ err: markErr, event: 'stripe_cancel_mark_failed' }, 'stripe_cancel_mark_failed');
        }
        log.warn({ err, reason, attempts, event: 'stripe_cancel_failed' }, 'stripe_cancel_failed');
        if (attempts >= STRIPE_CANCEL_STUCK_ATTEMPTS) {
          log.error({ reason, attempts, event: 'stripe_cancellation_stuck' }, 'stripe_cancellation_stuck');
        }
      }
    }
    req.log.info({ ...counts, event: 'stripe_cancel_done' }, 'stripe_cancel_done');
    return res.status(counts.failed ? 500 : 200).json(counts);
  };
}
