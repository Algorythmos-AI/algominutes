// POST /v1/purchases/verify (auth: Firebase ID token → uid) — A9.4/A9.5.
//
// StoreKit 2 (`jwsRepresentation`) OR Play (`purchaseToken` + `productId`). We
// verify the receipt SERVER-SIDE, extract the rail's durable id + plan +
// currentPeriodEnd, enforce cross-rail dedup, then grant entitlement through
// the repo. Entitlement is NEVER granted from a client "I'm Pro" flag — the
// signed receipt IS the proof.
//
// Matches contract shapes VerifyPurchaseRequest / VerifyPurchaseResponse
// (packages/contracts/src/schemas/billing.ts).

import {
  activateSubscription,
  findUidByRailId,
  getSubscription,
  deriveState,
  trackEvent,
} from '@algominutes/db';

import { verifyStoreKitPurchase } from '../lib/apple.js';
import { verifyPlaySubscription } from '../lib/google-play.js';
import { planFromStoreProductId } from '../lib/plans.js';
import { checkCrossRailDuplicate } from '../lib/dedup.js';

export async function verifyPurchaseRoute(req, res) {
  const uid = req.uid;
  const body = req.body || {};
  const rail = body.rail;

  if (rail !== 'apple_storekit' && rail !== 'google_play') {
    return res.status(400).json({ error: 'Invalid rail' });
  }

  // ── 1. Server-side receipt validation → durable id, product, period end ──
  let railKey; // { apple } | { google } for findUidByRailId
  let durable; // fields for activateSubscription
  let storeProductId;

  if (rail === 'apple_storekit') {
    if (!body.jwsRepresentation) {
      return res.status(400).json({ error: 'Missing jwsRepresentation' });
    }
    // TODO(A4-apple)/TODO(A11): real JWS cert-chain verification lives in lib/apple.js.
    const tx = verifyStoreKitPurchase(body.jwsRepresentation);
    if (!tx.originalTransactionId) {
      return res.status(400).json({ error: 'Unverifiable transaction' });
    }
    if (tx.revoked) {
      // A refunded/revoked receipt must never grant entitlement.
      req.log.warn({ uid, railId: tx.originalTransactionId, event: 'apple_receipt_revoked' }, 'apple_receipt_revoked');
      return res.status(409).json({ error: 'Receipt revoked' });
    }
    storeProductId = tx.productId;
    railKey = { apple: tx.originalTransactionId };
    durable = {
      appleOriginalTransactionId: tx.originalTransactionId,
      currentPeriodEnd: tx.currentPeriodEnd,
    };
  } else {
    if (!body.purchaseToken || !body.productId) {
      return res.status(400).json({ error: 'Missing purchaseToken or productId' });
    }
    // TODO(A11): real Play Developer API verification lives in lib/google-play.js.
    const sub = await verifyPlaySubscription({
      productId: body.productId,
      purchaseToken: body.purchaseToken,
    });
    storeProductId = sub.productId;
    railKey = { google: sub.purchaseToken };
    durable = {
      googlePurchaseToken: sub.purchaseToken,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
  }

  if (!durable.currentPeriodEnd) {
    return res.status(400).json({ error: 'No active period on receipt' });
  }

  const { plan, known } = planFromStoreProductId(storeProductId);
  if (!known) {
    // Not fatal (Pro is the only paid plan) but a genuinely unknown SKU means
    // the catalog drifted from store config — make it visible, don't swallow it.
    req.log.warn({ uid, rail, storeProductId, event: 'unknown_store_product' }, 'unknown_store_product');
  }

  // ── 2. Cross-rail CONFLICT: this rail id already maps to a DIFFERENT uid ──
  // A store subscription can't back two accounts. Reject; do not re-key it.
  const existingUid = await findUidByRailId(railKey);
  if (existingUid && existingUid !== uid) {
    req.log.warn(
      { uid, existingUid, rail, event: 'cross_rail_conflict' },
      'cross_rail_conflict',
    );
    return res.status(409).json({ error: 'Receipt already linked to another account' });
  }

  // ── 3. Cross-rail DUPLICATE: same uid already current on another rail ──
  // Keep the single entitlement, log, surface to support. Never double-grant.
  await checkCrossRailDuplicate({ uid, incomingRail: rail, log: req.log, traceId: req.traceId });

  // ── 4. Grant entitlement (idempotent upsert on uid) ──
  await activateSubscription({
    uid,
    rail,
    plan,
    currentPeriodEnd: durable.currentPeriodEnd,
    appleOriginalTransactionId: durable.appleOriginalTransactionId,
    googlePurchaseToken: durable.googlePurchaseToken,
  });

  await trackEvent({ uid, event: 'purchase', props: { rail, plan } });

  const row = await getSubscription(uid);
  const entitlementState = deriveState(row);
  req.log.info(
    { uid, rail, plan, currentPeriodEnd: durable.currentPeriodEnd, entitlementState, event: 'purchase_verified' },
    'purchase_verified',
  );

  // VerifyPurchaseResponse: entitlementState ∈ active | trialing | free_floor.
  // deriveState can return 'expired'; collapse it to 'free_floor' for the wire.
  const wireState = entitlementState === 'expired' ? 'free_floor' : entitlementState;
  return res.json({ ok: true, entitlementState: wireState });
}
