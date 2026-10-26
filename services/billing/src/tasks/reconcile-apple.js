// POST /tasks/reconcile-apple (Cloud Scheduler, hourly, OIDC as run-jobs; RELEASE.md PR 26, BLOCKERS
// "Missed cancellation/expiry webhook").
//
// App Store notifications drive an Apple subscriber's entitlement (webhooks/apple.js). One that never
// arrives leaves it wrong: a missed DID_RENEW cuts a paying subscriber off when the stored period lapses, a
// missed REFUND or EXPIRED keeps Pro on until it does, and one that arrives out of order can undo a newer
// one. So each run asks Apple (lib/app-store-server.js) about the subscriptions due a check
// (listAppleSubscriptionsDue: near the end of their period, or not checked for a week) and writes what Apple
// says, unless a notification or purchase wrote the row after it was read (recordAppleCheck: that is newer).
//
// Each subscription is its own try: one failure is logged and counted, and the run goes on. A refusal of our
// key stops the run (every call would fail the same way) and alerts. With no key configured it does
// nothing, and says so.
import { AppStoreServerError } from '../lib/app-store-server.js';
import { planFromStoreProductId } from '../lib/plans.js';

const BATCH = 100;
// Billing's requests time out at 60 s (cloud-run.tf): a run stops starting new checks after this, and what's
// left is due again next run.
const BUDGET_MS = 40_000;

const at = (iso) => (iso ? Date.parse(iso) : NaN);
const earlier = (iso, nowMs) => new Date(Math.min(Number.isFinite(at(iso)) ? at(iso) : nowMs, nowMs)).toISOString();

/**
 * What Apple's answer means for the stored subscription: { status, currentPeriodEnd, plan }, or null when
 * nothing changes (or the answer says nothing we act on). Pure; `nowMs` is the check's time.
 */
export function appleChange(row, apple, nowMs) {
  if (!apple) return null;
  const plan = planFromStoreProductId(apple.productId).plan;
  let next;
  if (apple.revoked || apple.status === 'revoked') {
    // Refunded or revoked (Family Sharing removed): no longer entitled, from now.
    next = { status: 'refunded', currentPeriodEnd: earlier(row.currentPeriodEnd, nowMs) };
  } else if (apple.status === 'active') {
    next = { status: 'active', currentPeriodEnd: apple.currentPeriodEnd };
  } else if (apple.status === 'grace') {
    // Apple still gives the subscriber the service while it retries the charge: so do we, until grace ends.
    next = { status: 'past_due', currentPeriodEnd: apple.graceEnd || apple.currentPeriodEnd };
  } else if (apple.status === 'billing_retry') {
    // Retrying the charge without a grace period: the period has lapsed.
    next = { status: 'past_due', currentPeriodEnd: apple.currentPeriodEnd };
  } else if (apple.status === 'expired') {
    next = { status: 'expired', currentPeriodEnd: earlier(apple.currentPeriodEnd, nowMs) };
  } else {
    return null;
  }
  if (!next.currentPeriodEnd) return null;
  const same = next.status === row.status
    && at(next.currentPeriodEnd) === at(row.currentPeriodEnd)
    && plan === row.plan;
  return same ? null : { ...next, plan };
}

/**
 * The route. `appStoreServer(log)` answers { client }, or { missing } when no key is configured; `repo` is
 * @algominutes/db's listAppleSubscriptionsDue, recordAppleCheck and trackEvent.
 */
export function createReconcileApple({ appStoreServer, repo, now = Date.now, batch = BATCH, budgetMs = BUDGET_MS }) {
  return async function reconcileApple(req, res) {
    const started = now();
    let client;
    let missing;
    try {
      ({ client, missing } = await appStoreServer(req.log));
    } catch (err) {
      // The key couldn't be read (Secret Manager refused or unreachable): nothing can be checked this run.
      req.log.error({ err, step: 'key', event: 'apple_reconcile_failed' }, 'apple_reconcile_failed');
      return res.status(500).json({ error: 'Reconcile failed' });
    }
    if (!client) {
      req.log.warn({ missing, event: 'apple_reconcile_not_configured' }, 'apple_reconcile_not_configured');
      return res.status(200).json({ skipped: 'not_configured' });
    }
    let due;
    try {
      due = await repo.listAppleSubscriptionsDue(batch);
    } catch (err) {
      req.log.error({ err, step: 'list', event: 'apple_reconcile_failed' }, 'apple_reconcile_failed');
      return res.status(500).json({ error: 'Reconcile failed' });
    }
    const counts = { due: due.length, checked: 0, updated: 0, raced: 0, unknown: 0, failed: 0, deferred: 0 };
    for (const [i, row] of due.entries()) {
      if (now() - started > budgetMs) {
        counts.deferred = due.length - i;
        break;
      }
      const log = req.log.child({ uid: row.uid, userId: row.uid, railId: row.originalTransactionId });
      try {
        const apple = await client.subscriptionStatus(row.originalTransactionId);
        if (!apple) {
          // Neither environment knows it: nothing to act on. Seen again next week.
          counts.unknown += 1;
          log.warn({ event: 'apple_subscription_not_found' }, 'apple_subscription_not_found');
        }
        const change = appleChange(row, apple, now());
        const outcome = await repo.recordAppleCheck(row, change);
        counts.checked += 1;
        if (outcome === 'raced') {
          counts.raced += 1;
          log.info({ event: 'apple_reconcile_raced' }, 'apple_reconcile_raced');
        } else if (outcome === 'updated') {
          counts.updated += 1;
          log.info({
            event: 'apple_reconciled', environment: apple.environment, appleStatus: apple.status,
            from: { status: row.status, currentPeriodEnd: row.currentPeriodEnd },
            to: { status: change.status, currentPeriodEnd: change.currentPeriodEnd },
          }, 'apple_reconciled');
          if (change.status === 'expired' || change.status === 'refunded') {
            // The funnel's record, after the entitlement is right: its failure is logged, not the check's.
            await repo.trackEvent({ uid: row.uid, event: 'cancellation', props: { rail: 'apple_storekit', reason: `reconcile_${change.status}` } })
              .catch((err) => log.error({ err, event: 'apple_reconcile_event_failed' }, 'apple_reconcile_event_failed'));
          }
        }
      } catch (err) {
        if (err instanceof AppStoreServerError && err.unauthorized) {
          // Our key, issuer id or bundle id: every call would be refused the same way.
          log.error({ err, status: err.status, errorCode: err.errorCode, event: 'apple_server_api_unauthorized' }, 'apple_server_api_unauthorized');
          return res.status(500).json({ error: 'App Store Server API refused our key', ...counts });
        }
        counts.failed += 1;
        log.warn({ err, status: err?.status, errorCode: err?.errorCode, code: err?.code, event: 'apple_reconcile_item_failed' }, 'apple_reconcile_item_failed');
      }
    }
    req.log.info({ ...counts, event: 'apple_reconcile_done' }, 'apple_reconcile_done');
    return res.status(counts.failed ? 500 : 200).json(counts);
  };
}
