// Cross-rail dedup helpers (A9.4).
//
// Two distinct rules, both enforcing "entitlement is ONE row per uid, granted
// only from a server-validated receipt/webhook":
//
//   1. CROSS-RAIL CONFLICT — a rail's durable id already maps to a DIFFERENT
//      uid. A single store subscription can't back two accounts, so we REJECT.
//      (Enforced inline in the verify route via findUidByRailId; this module
//      exposes the shared log-shape helper.)
//
//   2. CROSS-RAIL DUPLICATE — the SAME uid activates a second rail while the
//      first is still current. We keep the single entitlement row (activateSub
//      is an upsert on uid, so it never double-grants), LOG it, and surface to
//      support — a store double-purchase can't be auto-refunded server-side.

import { getSubscription, deriveState } from '@algominutes/db';

/**
 * Detect rule (2): does `uid` already hold a CURRENT entitlement from a rail
 * different from `incomingRail`? Returns { duplicate, existingRail }.
 * Logs `cross_rail_duplicate` when true. Never blocks activation — the caller
 * still writes the single row; this only records the double-charge for support.
 */
export async function checkCrossRailDuplicate({ uid, incomingRail, log, traceId }) {
  const existing = await getSubscription(uid);
  if (!existing) return { duplicate: false, existingRail: null };

  const current = deriveState(existing) === 'active';
  const existingRail = existing.source || null;

  if (current && existingRail && existingRail !== incomingRail) {
    log.warn(
      { uid, traceId, existingRail, incomingRail, event: 'cross_rail_duplicate' },
      'cross_rail_duplicate',
    );
    return { duplicate: true, existingRail };
  }
  return { duplicate: false, existingRail };
}
