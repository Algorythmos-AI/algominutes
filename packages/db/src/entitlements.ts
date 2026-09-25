/**
 * Entitlement resolution (A9.1 / A9.3). Checked SERVER-SIDE on every metered
 * action — never trust the client. Combines the reverse-trial state machine
 * (subscriptions, derived from server time) with metered usage (usage_ledger)
 * and the authoritative quota (config).
 *
 * State → included minutes:
 *   trialing   → Pro-level minutes (full features, bounded — trialIncludedMinutes)
 *   active     → the paid plan's minutes (monthlyIncludedMinutes)
 *   free_floor → FREE_FLOOR_MINUTES (config, UNSET → fails safe to 0)
 *
 * A live manual grant (entitlement_grants, internal testers) counts as `active`
 * on the granted plan, unless a real paid subscription is already active.
 */
import {
  PlanId,
  EntitlementState,
  monthlyIncludedMinutes,
  trialIncludedMinutes,
  freeFloorMinutes,
} from '@algominutes/contracts';
import { usedMinutes, currentBillingPeriod } from './usage-repo.js';
import { getSubscription, deriveState } from './subscriptions-repo.js';
import { getActiveGrant } from './entitlement-grants-repo.js';

export interface Entitlement {
  uid: string;
  state: EntitlementState;
  plan: PlanId; // effective plan for display/limits
  billingPeriod: string;
  includedMinutes: number | null; // null = unmetered (not used by current tiers)
  usedMinutes: number;
  remainingMinutes: number; // Infinity when includedMinutes is null
  overQuota: boolean;
  trialEndsAt: string | null; // ISO; set only while trialing (reverse trial end)
}

export async function resolveEntitlement(uid: string): Promise<Entitlement> {
  const period = currentBillingPeriod();
  const sub = await getSubscription(uid);
  const derived = deriveState(sub);
  const grant = derived === 'active' ? null : await getActiveGrant(uid);
  const state: EntitlementState = grant ? 'active' : derived;

  let plan: PlanId;
  let included: number | null;
  if (grant) {
    plan = grant.plan;
    included = grant.includedMinutes ?? monthlyIncludedMinutes(grant.plan);
  } else if (state === 'active') {
    plan = ((sub?.plan as PlanId) || 'pro');
    included = monthlyIncludedMinutes(plan);
  } else if (state === 'trialing') {
    plan = 'pro'; // full features during the reverse trial
    included = trialIncludedMinutes();
  } else {
    plan = 'free';
    included = freeFloorMinutes(); // UNSET config → 0 (fail safe)
  }

  const used = await usedMinutes(uid, period);
  const remaining = included == null ? Infinity : Math.max(0, included - used);
  return {
    uid,
    state,
    plan,
    billingPeriod: period,
    includedMinutes: included,
    usedMinutes: used,
    remainingMinutes: remaining,
    overQuota: included != null && used >= included,
    trialEndsAt: state === 'trialing' && sub?.trial_end ? new Date(sub.trial_end).toISOString() : null,
  };
}

export class QuotaExceededError extends Error {
  code = 'QUOTA_EXCEEDED' as const;
  constructor(
    public readonly entitlement: Entitlement,
    public readonly requestedMinutes: number,
  ) {
    super(
      `quota_exceeded: state ${entitlement.state}, used ${entitlement.usedMinutes} + requested ${requestedMinutes} > ${entitlement.includedMinutes} min`,
    );
    this.name = 'QuotaExceededError';
  }
}

/**
 * Assert a user may consume `requestedMinutes`. Call BEFORE queuing transcode
 * (A9.2 — never pay Google for STT on over-quota work). Throws QuotaExceededError
 * if it would exceed the current entitlement. Note: on the free floor with an
 * UNSET FREE_FLOOR_MINUTES this is 0, so ALL metered work is blocked until the
 * number is set post-COGS (A9-pricing) — deliberate fail-safe, not a bug.
 */
export async function assertCanMeter(uid: string, requestedMinutes: number): Promise<Entitlement> {
  const ent = await resolveEntitlement(uid);
  if (ent.includedMinutes != null && ent.usedMinutes + requestedMinutes > ent.includedMinutes) {
    throw new QuotaExceededError(ent, requestedMinutes);
  }
  return ent;
}
