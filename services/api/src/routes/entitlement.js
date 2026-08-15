// GET /v1/entitlement — server-resolved plan + metered usage (A9.1).
//
// The client is NEVER trusted for quota state: this reads the user's plan
// (subscriptions) and their metered usage (usage_ledger) from Postgres via the
// @algominutes/db repo layer and returns the EntitlementResponse contract shape.
// The same shaper is reused by the ingest meter gate (process-intelligence.js)
// so the 402 quota body and this endpoint agree byte-for-byte.

import { resolveEntitlement } from '@algominutes/db';

/**
 * Map the repo's Entitlement (remainingMinutes is Infinity when unmetered) onto
 * the wire contract EntitlementResponse (remainingMinutes is null when
 * includedMinutes is null). Keeps a single source of truth for the shape.
 */
export function toEntitlementResponse(ent) {
  return {
    plan: ent.plan,
    billingPeriod: ent.billingPeriod,
    includedMinutes: ent.includedMinutes,
    usedMinutes: ent.usedMinutes,
    // null (not Infinity) for unmetered plans, matching EntitlementResponse.
    remainingMinutes: ent.includedMinutes == null ? null : ent.remainingMinutes,
    overQuota: ent.overQuota,
  };
}

export async function entitlementRoute(req, res) {
  const ent = await resolveEntitlement(req.uid);
  req.log.info({ plan: ent.plan, usedMinutes: ent.usedMinutes, overQuota: ent.overQuota }, 'entitlement_resolved');
  return res.json(toEntitlementResponse(ent));
}
