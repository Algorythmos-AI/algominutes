// POST /webhooks/google (PUBLIC, NO Firebase auth) — A9.5, Android SERVER side.
//
// Play Real-Time Developer Notifications arrive as a Pub/Sub PUSH: the body is
// { message: { data: <base64 JSON> }, subscription }. The decoded data carries
// { subscriptionNotification: { purchaseToken, subscriptionId, notificationType } }.
// A notification is only a TRIGGER — the authoritative state comes from
// re-verifying the purchaseToken against the Play Developer API (the receipt
// validation is the credential; TODO(A11)). We then drive the state machine:
//
//   RENEWED / PURCHASED / RESTARTED / RECOVERED → activate (fresh expiry)
//   IN_GRACE_PERIOD                             → billing retry / grace (past_due)
//   ON_HOLD / PAUSED                            → suspend (status, revoke on lapse)
//   CANCELED                                    → cancellation (keep expiry = grace)
//   EXPIRED                                     → expired
//   REVOKED                                     → refund (revoke immediately)
//
// uid resolution: findUidByRailId({ google: purchaseToken }). Play never knows
// our uid; an unseen token (no prior /v1/purchases/verify) resolves to null —
// log and ack.
//
// Pub/Sub redelivers on non-2xx. We ack (200) on success AND on
// permanently-unactionable messages (bad shape, unknown token) so Pub/Sub does
// not retry-storm; we return 500 only on a transient failure worth retrying.

import {
  activateSubscription,
  setSubscriptionStatus,
  findUidByRailId,
  trackEvent,
} from '@algominutes/db';

import { verifyPlaySubscription, PLAY_NOTIFICATION } from '../lib/google-play.js';

function decodePubSubMessage(body) {
  const data = body?.message?.data;
  if (!data) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    // silent-catch-ok: malformed base64/JSON is surfaced by the caller as a 400 (permanent).
    return undefined;
  }
}

export async function googleWebhookRoute(req, res) {
  const decoded = decodePubSubMessage(req.body);
  if (decoded === null) {
    return res.status(400).json({ error: 'Missing message data' });
  }
  if (decoded === undefined) {
    req.log.warn({ event: 'google_message_undecodable' }, 'google_message_undecodable');
    return res.status(400).json({ error: 'Undecodable message' });
  }

  const notif = decoded.subscriptionNotification;
  if (!notif) {
    // testNotification / voidedPurchase / oneTimeProduct — nothing to do here.
    req.log.info({ event: 'google_non_subscription_notification' }, 'google_non_subscription_notification');
    return res.status(200).json({ received: true });
  }

  const { purchaseToken, subscriptionId: productId, notificationType } = notif;
  const log = req.log.child({ rail: 'google', notificationType, railId: purchaseToken });

  if (!purchaseToken || !productId) {
    log.warn({ event: 'google_notification_incomplete' }, 'google_notification_incomplete');
    return res.status(400).json({ error: 'Incomplete notification' });
  }

  const uid = await findUidByRailId({ google: purchaseToken });
  if (!uid) {
    // Token never bound to a uid (no prior verify). Ack; nothing to grant.
    log.warn({ event: 'google_uid_unresolved' }, 'google_uid_unresolved');
    return res.status(200).json({ received: true });
  }

  // Re-verify against Play for the authoritative expiry/state.
  // TODO(A11): verify against live Google (purchases.subscriptions.get).
  let sub;
  try {
    sub = await verifyPlaySubscription({ productId, purchaseToken });
  } catch (err) {
    // A Play API blip is transient — 500 so Pub/Sub redelivers.
    log.error({ err, uid, event: 'google_verify_failed' }, 'google_verify_failed');
    return res.status(500).json({ error: 'verify_failed' });
  }

  switch (notificationType) {
    case PLAY_NOTIFICATION.PURCHASED:
    case PLAY_NOTIFICATION.RENEWED:
    case PLAY_NOTIFICATION.RESTARTED:
    case PLAY_NOTIFICATION.RECOVERED: {
      if (!sub.currentPeriodEnd) break;
      await activateSubscription({
        uid,
        rail: 'google_play',
        plan: 'pro',
        currentPeriodEnd: sub.currentPeriodEnd,
        googlePurchaseToken: purchaseToken,
      });
      // A brand-new purchase is a conversion; a renewal/recovery is not.
      if (notificationType === PLAY_NOTIFICATION.PURCHASED) {
        await trackEvent({ uid, event: 'purchase', props: { rail: 'google_play', plan: 'pro' } });
      }
      log.info({ uid, currentPeriodEnd: sub.currentPeriodEnd, event: 'google_activated' }, 'google_activated');
      break;
    }
    case PLAY_NOTIFICATION.IN_GRACE_PERIOD: {
      // Billing retry / grace. Keep expiry; user stays active until it lapses.
      await setSubscriptionStatus(uid, 'past_due', sub.currentPeriodEnd);
      log.info({ uid, event: 'google_grace_period' }, 'google_grace_period');
      break;
    }
    case PLAY_NOTIFICATION.ON_HOLD:
    case PLAY_NOTIFICATION.PAUSED: {
      // Account hold / pause: entitlement suspended. deriveState flips to
      // free_floor once the stored period end passes.
      await setSubscriptionStatus(uid, 'on_hold', sub.currentPeriodEnd);
      log.info({ uid, event: 'google_on_hold' }, 'google_on_hold');
      break;
    }
    case PLAY_NOTIFICATION.CANCELED: {
      // Cancellation: keep expiry (grace) — access until the period lapses.
      await setSubscriptionStatus(uid, 'canceled', sub.currentPeriodEnd);
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'google_play' } });
      log.info({ uid, event: 'google_canceled' }, 'google_canceled');
      break;
    }
    case PLAY_NOTIFICATION.EXPIRED: {
      await setSubscriptionStatus(uid, 'expired', new Date().toISOString());
      log.info({ uid, event: 'google_expired' }, 'google_expired');
      break;
    }
    case PLAY_NOTIFICATION.REVOKED: {
      // Refund / chargeback: revoke immediately.
      await setSubscriptionStatus(uid, 'refunded', new Date().toISOString());
      await trackEvent({ uid, event: 'cancellation', props: { rail: 'google_play', reason: 'revoked' } });
      log.info({ uid, event: 'google_revoked' }, 'google_revoked');
      break;
    }
    default:
      log.info({ event: 'google_event_ignored' }, 'google_event_ignored');
      break;
  }

  return res.status(200).json({ received: true });
}
