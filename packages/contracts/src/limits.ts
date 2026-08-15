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

// ── Reverse trial + pricing (A9.3, DECIDED) ─────────────────────────────────
// Day 1–7: full features, no card (trial minutes = Pro's, to bound cost). After
// day 7: the free floor.
export const TRIAL_DAYS = 7;

/** During the reverse trial a user gets Pro-level minutes (bounded, not unlimited). */
export function trialIncludedMinutes(): number | null {
  return PLAN_MONTHLY_INCLUDED_MINUTES.pro;
}

// ⚠️ FREE_FLOOR_MINUTES is DELIBERATELY UNSET (A9.3). The right number depends on
// the blended COGS/min that A11 measures; shipping a guessed value risks an
// unbounded bill. It therefore FAILS SAFE: `null` → 0 metered minutes on the free
// floor until a real number is set here. TODO(A9-pricing): set after A11 COGS.
export const FREE_FLOOR_MINUTES: number | null = null;

/** Minutes on the post-trial free floor. Null config → 0 (fail safe). */
export function freeFloorMinutes(): number {
  return FREE_FLOOR_MINUTES == null ? 0 : FREE_FLOOR_MINUTES;
}

// Prices are config, not hardcoded in UI. Amounts in the store/Stripe are the
// source of truth for charging; these drive display + must be kept in sync.
export const PRICING = {
  currency: 'AUD',
  proMonthly: 14.99,
  proAnnual: 149.9, // ≈ two months free
  // TODO(A9-pricing): confirm the annual figure + store/Stripe product prices match.
} as const;

/** Entitlement lifecycle states (A9.3): trialing → active | (expired →) free_floor. */
export type EntitlementState = 'trialing' | 'active' | 'expired' | 'free_floor';


// ── A10 compliance constants ─────────────────────────────────────────────────
// Bump when the documents change; a bump requires re-acceptance (terms_acceptance).
export const TERMS_VERSION = '2026-08-16';
export const PRIVACY_VERSION = '2026-08-16';

// Default note retention when the user hasn't set one (A10 #5). See docs/DATA-RETENTION.md.
// null = keep until the user deletes (with the soft-delete + 30-day backup window).
export const DEFAULT_RETENTION_DAYS: number | null = null;
export const RETENTION_OPTIONS_DAYS = [30, 90, 180, 365] as const; // user-selectable + "keep until deleted"
