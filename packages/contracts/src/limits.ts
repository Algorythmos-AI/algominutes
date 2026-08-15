// Recording limits — plan-derived, config-driven (A6.2).
//
// Replaces the web client's hardcoded 2-hour cap ("Slater staff meetings run up
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
