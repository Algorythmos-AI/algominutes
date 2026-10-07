/**
 * Stripe subscriptions to cancel because their account was deleted (RELEASE.md PR 28b; migration 030).
 * Account deletion removes the subscriptions row, so without this nothing would stop the charges. The
 * deletion records its Stripe subscription in its own transaction (account-repo), a checkout webhook
 * arriving after the deletion records its one here, and billing's cancel-stripe task cancels each with
 * Stripe, retrying with backoff until Stripe confirms.
 */
import { getPool, isPostgresEnabled } from './db.js';

/** After this many failed attempts a cancellation is reported stuck on every run, until a person acts. */
export const STRIPE_CANCEL_STUCK_ATTEMPTS = 10;

export interface StripeCancellation {
  stripeSubscriptionId: string;
  attempts: number;
  traceId: string | null;
}

/**
 * When `uid`'s account was deleted (its tombstone exists), records `subscriptionId` for cancellation and
 * answers true: a subscription for a deleted account is cancelled, never activated. False otherwise.
 */
export async function cancelIfAccountDeleted(uid: string, subscriptionId: string, traceId?: string | null): Promise<boolean> {
  if (!isPostgresEnabled()) return false;
  const { rows } = await getPool().query(`SELECT 1 FROM account_deletions WHERE uid = $1`, [uid]);
  if (!rows.length) return false;
  await getPool().query(
    `INSERT INTO stripe_cancellations (stripe_subscription_id, trace_id) VALUES ($1, $2)
     ON CONFLICT (stripe_subscription_id) DO NOTHING`,
    [subscriptionId, traceId ?? null],
  );
  return true;
}

/**
 * Queue a Stripe subscription to be cancelled by the cancel-stripe task, with its retries (RELEASE.md rev 11,
 * H21: a second subscription for an account that is already paying). Queued once however often it's asked.
 */
export async function queueStripeCancellation(subscriptionId: string, traceId?: string | null): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `INSERT INTO stripe_cancellations (stripe_subscription_id, trace_id) VALUES ($1, $2)
     ON CONFLICT (stripe_subscription_id) DO NOTHING`,
    [subscriptionId, traceId ?? null],
  );
}

/** The cancellations due an attempt, oldest first. */
export async function listDueStripeCancellations(limit = 50): Promise<StripeCancellation[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `SELECT stripe_subscription_id AS "stripeSubscriptionId", attempts, trace_id AS "traceId"
       FROM stripe_cancellations
      WHERE cancelled_at IS NULL AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at, stripe_subscription_id
      LIMIT $1`,
    [limit],
  );
  return rows as StripeCancellation[];
}

/** Stripe confirmed it: cancelled, or already over. */
export async function markStripeCancelled(subscriptionId: string): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `UPDATE stripe_cancellations SET cancelled_at = NOW(), last_error = NULL WHERE stripe_subscription_id = $1`,
    [subscriptionId],
  );
}

/**
 * An attempt failed: counted, with the next one backed off (15 minutes, doubling, at most a day). `reason`
 * is a short fixed code (Stripe's error code or type), never a message. Returns the attempts so far.
 */
export async function markStripeCancelFailed(subscriptionId: string, reason: string): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rows } = await getPool().query(
    `UPDATE stripe_cancellations
        SET attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = NOW() + LEAST(INTERVAL '15 minutes' * POWER(2, attempts), INTERVAL '1 day')
      WHERE stripe_subscription_id = $1
      RETURNING attempts`,
    [subscriptionId, String(reason).slice(0, 80)],
  );
  return rows[0]?.attempts ?? 0;
}
