// Recording limits — plan-derived, config-driven (A6.2).
//
// Replaces the web client's hardcoded 2-hour cap ("staff meetings run up
// to 2 h"). This is the PER-RECORDING maximum duration; the monthly minute quota
// is a separate entitlement concern (A9). The per-plan values are tunable in A9;
// until entitlements resolve, clients use DEFAULT_MAX_RECORDING_SECONDS.

export type PlanId = 'free' | 'pro' | 'team';

/** Per-recording maximum duration, in seconds, by plan tier. */
export const RECORDING_LIMITS: Record<PlanId, { maxRecordingSeconds: number }> = {
  free: { maxRecordingSeconds: 2 * 60 * 60 }, // 2h — default-tier cap (unchanged behaviour)
  pro: { maxRecordingSeconds: 4 * 60 * 60 }, // TODO(A9): confirm the Pro per-recording cap
  team: { maxRecordingSeconds: 4 * 60 * 60 }, // TODO(A9): confirm the Team per-recording cap
};

export const DEFAULT_PLAN_ID: PlanId = 'free';

/** The cap a client uses before it knows the signed-in user's plan (A9). */
export const DEFAULT_MAX_RECORDING_SECONDS =
  RECORDING_LIMITS[DEFAULT_PLAN_ID].maxRecordingSeconds;

/** Resolve the per-recording cap for a plan, falling back to the default tier. */
export function maxRecordingSecondsForPlan(plan: PlanId = DEFAULT_PLAN_ID): number {
  return (RECORDING_LIMITS[plan] ?? RECORDING_LIMITS[DEFAULT_PLAN_ID]).maxRecordingSeconds;
}

// ── Monthly minute quota (A9.1) ──────────────────────────────────────────────
// The AUTHORITATIVE per-plan monthly included minutes. The `plans` DB table
// (migration 007) mirrors these for FK/admin; this config is the source of truth.
// `null` = not a fixed monthly quota (team is per-seat, P2).
export const PLAN_MONTHLY_INCLUDED_MINUTES: Record<PlanId, number | null> = {
  free: 120,
  pro: 1500,
  team: null,
};

/** Monthly included minutes for a plan (null = per-seat/unmetered here). */
export function monthlyIncludedMinutes(plan: PlanId = DEFAULT_PLAN_ID): number | null {
  return plan in PLAN_MONTHLY_INCLUDED_MINUTES
    ? PLAN_MONTHLY_INCLUDED_MINUTES[plan]
    : PLAN_MONTHLY_INCLUDED_MINUTES[DEFAULT_PLAN_ID];
}

// Entitlement is checked SERVER-SIDE on every metered action (A9.1) — never trust
// the client. The check lives in @algominutes/db (entitlements.ts) over usage_ledger.

