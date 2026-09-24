// POST /webhooks/apple (PUBLIC, signature-verified, NO Firebase auth) — A9.5.
//
// App Store Server Notifications V2. The body is { signedPayload }, a JWS whose
// decoded payload carries { notificationType, subtype, data:{ signedTransactionInfo } }.
// The signed payload IS the credential. Until full x5c-chain verification lands
// (PR-32, lib/apple.js), verifyAndDecodeJws refuses and this answers 503, so
// Apple retries and no forged notification is ever trusted. We decode the transaction to the durable
// `originalTransactionId`, resolve it to a uid, and drive the state machine:
//
//   DID_RENEW              → renew (activate with new expiresDate)
//   EXPIRED               → expired (period lapsed)
//   GRACE_PERIOD_EXPIRED  → expired (grace ran out)
//   DID_FAIL_TO_RENEW     → billing retry / grace (past_due, keep period end)
//   REFUND                → refund (revoke immediately)
//
// uid resolution: findUidByRailId({ apple: originalTransactionId }). Apple never
// knows our uid, so a receipt we've never seen (no prior /v1/purchases/verify)
// resolves to null — we log and ack rather than fabricate a grant.

import {
  activateSubscription,
  setSubscriptionStatus,
  findUidByRailId,
  trackEvent,
} from '@algominutes/db';

import { verifyAndDecodeJws, extractTransaction } from '../lib/apple.js';

export async function appleWebhookRoute(req, res) {
  const signedPayload = req.body?.signedPayload;
  if (!signedPayload) {
    return res.status(400).json({ error: 'Missing signedPayload' });
  }

  let notification;
  let tx;
  try {
    // TODO(A4-apple)/TODO(A11): verifyAndDecodeJws decodes today; production must
    // verify the x5c chain to Apple Root CA - G3 before trusting the payload.
    notification = verifyAndDecodeJws(signedPayload);
    const signedTx = notification?.data?.signedTransactionInfo;
    if (!signedTx) {
      req.log.warn({ event: 'apple_no_transaction_info' }, 'apple_no_transaction_info');
      return res.status(400).json({ error: 'No transaction info' });
    }
    tx = extractTransaction(verifyAndDecodeJws(signedTx));
  } catch (err) {
    req.log.warn({ err, event: 'apple_payload_invalid' }, 'apple_payload_invalid');
    const status = err?.status === 503 ? 503 : 400;
    return res.status(status).json({ error: 'Invalid payload' });
  }

  const notificationType = notification.notificationType;
  const subtype = notification.subtype || null;
  const originalTransactionId = tx.originalTransactionId;
  const log = req.log.child({ rail: 'apple', notificationType, subtype, railId: originalTransactionId });

  if (!originalTransactionId) {
    log.warn({ event: 'apple_no_original_transaction_id' }, 'apple_no_original_transaction_id');
    return res.status(400).json({ error: 'No originalTransactionId' });
  }

  const uid = await findUidByRailId({ apple: originalTransactionId });
  if (!uid) {
    // A receipt we've never verified for a known uid. Ack (200) so Apple stops
    // retrying; nothing to grant. The client's /v1/purchases/verify is the path
    // that first binds this originalTransactionId to a uid.
    log.warn({ event: 'apple_uid_unresolved' }, 'apple_uid_unresolved');
    return res.status(200).json({ received: true });
  }

  switch (notificationType) {
    case 'DID_RENEW': {
      if (!tx.currentPeriodEnd) break;
      await activateSubscription({
        uid,
        rail: 'apple_storekit',
        plan: 'pro',
        currentPeriodEnd: tx.currentPeriodEnd,
        appleOriginalTransactionId: originalTransactionId,
      });
      log.info({ uid, currentPeriodEnd: tx.currentPeriodEnd, event: 'apple_renewed' }, 'apple_renewed');
      break;
    }
    case 'DID_FAIL_TO_RENEW': {
      // Billing retry / grace period. Keep the current period end; deriveState
      // keeps the user active until it lapses.
      await setSubscriptionStatus(uid, 'past_due');
      log.info({ uid, event: 'apple_billing_retry' }, 'apple_billing_retry');
      break;
    }
    case 'GRACE_PERIOD_EXPIRED':
    case 'EXPIRED': {
      await setSubscriptionStatus(uid, 'expired', new Date().toISOString());
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'apple_storekit', reason: notificationType } });
      log.info({ uid, event: 'apple_expired' }, 'apple_expired');
      break;
    }
    case 'REFUND': {
      // Refund: revoke immediately.
      await setSubscriptionStatus(uid, 'refunded', new Date().toISOString());
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'apple_storekit', reason: 'refund' } });
      log.info({ uid, event: 'apple_refunded' }, 'apple_refunded');
      break;
    }
    default:
      log.info({ event: 'apple_event_ignored' }, 'apple_event_ignored');
      break;
  }

  return res.status(200).json({ received: true });
}
