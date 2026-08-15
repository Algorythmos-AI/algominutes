/**
 * subscriptions repo — the ONE entitlement source of truth (A9.4), keyed to the
 * user (uid), never the rail. The reverse-trial state machine (A9.3) is DERIVED
 * from server time + the stored fields on read, so it is correct even if the
 * expiry sweep hasn't run and regardless of client clock skew.
 *
 * States (A9.3): trialing → active | (expired →) free_floor.
 */
import { PlanId, DEFAULT_PLAN_ID, TRIAL_DAYS, EntitlementState } from '@algominutes/contracts';
import { getPool, isPostgresEnabled } from './db.js';

export interface SubscriptionRow {
  uid: string;
  plan: string;
  status: string;
  source: string | null;
  entitlement_state: string;
  trial_started_at: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  apple_original_transaction_id: string | null;
  google_purchase_token: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
}

export async function getSubscription(uid: string): Promise<SubscriptionRow | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query(`SELECT * FROM subscriptions WHERE uid = $1`, [uid]);
  return (rows[0] as SubscriptionRow) ?? null;
}

/**
 * Start the 7-day reverse trial for a user the first time they hit value. IDEMPOTENT:
 * if a row already exists it is returned unchanged — a reinstall (same uid) or a
 * second call never restarts the clock. Anonymous-reinstall-with-a-new-uid CAN still
 * restart (see BLOCKERS — device-bound anti-abuse is a flagged seam via deviceHash).
 */
export async function ensureTrial(uid: string, opts: { deviceHash?: string } = {}): Promise<SubscriptionRow> {
  if (!isPostgresEnabled()) {
    return {
      uid, plan: DEFAULT_PLAN_ID, status: 'trialing', source: null, entitlement_state: 'trialing',
      trial_started_at: null, trial_end: null, current_period_end: null,
      apple_original_transaction_id: null, google_purchase_token: null,
      stripe_subscription_id: null, stripe_customer_id: null,
    };
  }
  const { rows } = await getPool().query(
    `INSERT INTO subscriptions (uid, plan, status, entitlement_state, trial_started_at, trial_end, trial_device_hash)
       VALUES ($1, 'free', 'trialing', 'trialing', NOW(), NOW() + ($2 || ' days')::interval, $3)
     ON CONFLICT (uid) DO NOTHING
     RETURNING *`,
    [uid, String(TRIAL_DAYS), opts.deviceHash ?? null],
  );
  return rows[0] ?? (await getSubscription(uid))!;
}

/** Pure, server-time derivation of the current entitlement state. */
export function deriveState(row: SubscriptionRow | null, now: Date = new Date()): EntitlementState {
  if (!row) return 'trialing'; // brand-new caller; ensureTrial materialises it
  const periodEnd = row.current_period_end ? new Date(row.current_period_end) : null;
  if (periodEnd && periodEnd > now) return 'active'; // a paid period (any rail) is current
  const trialEnd = row.trial_end ? new Date(row.trial_end) : null;
  const everPaid =
    !!row.apple_original_transaction_id || !!row.google_purchase_token || !!row.stripe_subscription_id;
  if (trialEnd && trialEnd > now && !everPaid) return 'trialing';
  return 'free_floor';
}

export interface ActivateInput {
  uid: string;
  rail: 'stripe' | 'apple_storekit' | 'google_play';
  plan: PlanId;
  currentPeriodEnd: string; // ISO
  appleOriginalTransactionId?: string;
  googlePurchaseToken?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
}

/**
 * Grant/renew a paid subscription from a SERVER-VALIDATED receipt/webhook only.
 * Idempotent on the rail id. Records the rail's durable id so cross-rail dedup
 * (A9.4) can detect the same user buying on a second rail.
 */
export async function activateSubscription(input: ActivateInput): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `INSERT INTO subscriptions
       (uid, plan, status, entitlement_state, source, current_period_end,
        apple_original_transaction_id, google_purchase_token, stripe_subscription_id, stripe_customer_id, updated_at)
     VALUES ($1,$2,'active','active',$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (uid) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = 'active',
       entitlement_state = 'active',
       source = EXCLUDED.source,
       current_period_end = EXCLUDED.current_period_end,
       apple_original_transaction_id = COALESCE(EXCLUDED.apple_original_transaction_id, subscriptions.apple_original_transaction_id),
       google_purchase_token = COALESCE(EXCLUDED.google_purchase_token, subscriptions.google_purchase_token),
       stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, subscriptions.stripe_subscription_id),
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       updated_at = NOW()`,
    [
      input.uid, input.plan, input.rail, input.currentPeriodEnd,
      input.appleOriginalTransactionId ?? null, input.googlePurchaseToken ?? null,
      input.stripeSubscriptionId ?? null, input.stripeCustomerId ?? null,
    ],
  );
}

/** Cancellation/refund/expiry: keep current_period_end (grace) — derivation flips to free_floor when it passes. */
export async function setSubscriptionStatus(uid: string, status: string, currentPeriodEnd?: string | null): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `UPDATE subscriptions SET status = $2,
       current_period_end = COALESCE($3, current_period_end), updated_at = NOW() WHERE uid = $1`,
    [uid, status, currentPeriodEnd ?? null],
  );
}

/** Resolve a rail id → uid, for webhook handlers (which know only the rail id). */
export async function findUidByRailId(id: {
  apple?: string; google?: string; stripe?: string; stripeCustomer?: string;
}): Promise<string | null> {
  if (!isPostgresEnabled()) return null;
  const [col, val] = id.apple
    ? ['apple_original_transaction_id', id.apple]
    : id.google
      ? ['google_purchase_token', id.google]
      : id.stripe
        ? ['stripe_subscription_id', id.stripe]
        : ['stripe_customer_id', id.stripeCustomer];
  if (!val) return null;
  const { rows } = await getPool().query(`SELECT uid FROM subscriptions WHERE ${col} = $1`, [val]);
  return rows[0]?.uid ?? null;
}

/** Sweep: cache-flip elapsed trials to free_floor (derivation already handles reads). */
export async function expireElapsedTrials(): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE subscriptions SET entitlement_state = 'free_floor', updated_at = NOW()
       WHERE entitlement_state = 'trialing' AND trial_end < NOW()
         AND (current_period_end IS NULL OR current_period_end < NOW())`,
  );
  return rowCount ?? 0;
}
