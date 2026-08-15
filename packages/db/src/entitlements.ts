/**
 * Entitlement resolution (A9.1). Checked SERVER-SIDE on every metered action —
 * never trust the client. Combines the user's plan (subscriptions) with their
 * metered usage (usage_ledger) and the authoritative quota (config).
 *
 * OPEN decisions this stays neutral on (see DECISIONS.md):
 *   - A6.3 guest vs forced signup — callers pass the resolved uid; an anonymous
 *     uid resolves to the free tier just like a signed-in one.
 *   - A9.3 trial vs perpetual free — a `trialing` subscription with a future
 *     trial_end is honoured if present, but nothing here decides trials exist.
 */
import { PlanId, DEFAULT_PLAN_ID, monthlyIncludedMinutes } from '@algominutes/contracts';
import { getPool, isPostgresEnabled } from './db.js';
import { usedMinutes, currentBillingPeriod } from './usage-repo.js';

export interface Entitlement {
  uid: string;
  plan: PlanId;
  billingPeriod: string;
  includedMinutes: number | null; // null = unmetered here (team/per-seat)
  usedMinutes: number;
  remainingMinutes: number; // Infinity when includedMinutes is null
  overQuota: boolean;
}

/** The user's current plan from subscriptions, defaulting to the free tier. */
export async function getPlan(uid: string): Promise<PlanId> {
  if (!isPostgresEnabled()) return DEFAULT_PLAN_ID;
  const { rows } = await getPool().query(
    `SELECT plan, status, trial_end FROM subscriptions WHERE uid = $1`,
    [uid],
  );
  const row = rows[0];
  if (!row) return DEFAULT_PLAN_ID;
  // Active or in-trial subscriptions grant their plan; otherwise fall back to free.
  const active = row.status === 'active' || row.status === 'trialing' || row.status === 'past_due';
  return active ? (row.plan as PlanId) : DEFAULT_PLAN_ID;
}

export async function resolveEntitlement(uid: string): Promise<Entitlement> {
  const period = currentBillingPeriod();
  const plan = await getPlan(uid);
  const included = monthlyIncludedMinutes(plan);
  const used = await usedMinutes(uid, period);
  const remaining = included == null ? Infinity : Math.max(0, included - used);
  return {
    uid,
    plan,
    billingPeriod: period,
    includedMinutes: included,
    usedMinutes: used,
    remainingMinutes: remaining,
    overQuota: included != null && used >= included,
  };
}

export class QuotaExceededError extends Error {
  code = 'QUOTA_EXCEEDED' as const;
  constructor(
    public readonly entitlement: Entitlement,
    public readonly requestedMinutes: number,
  ) {
    super(
      `quota_exceeded: used ${entitlement.usedMinutes} + requested ${requestedMinutes} > ${entitlement.includedMinutes} min (${entitlement.plan})`,
    );
    this.name = 'QuotaExceededError';
  }
}

/**
 * Assert a user may consume `requestedMinutes`. Call BEFORE queuing transcode
 * (A9.2 — rejecting over-quota work after paying Google for STT is the expensive
 * mistake). Throws QuotaExceededError if it would exceed the plan quota.
 */
export async function assertCanMeter(uid: string, requestedMinutes: number): Promise<Entitlement> {
  const ent = await resolveEntitlement(uid);
  if (ent.includedMinutes != null && ent.usedMinutes + requestedMinutes > ent.includedMinutes) {
    throw new QuotaExceededError(ent, requestedMinutes);
  }
  return ent;
}
