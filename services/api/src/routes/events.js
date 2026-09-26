import { trackEvent } from '@algominutes/db';
import { TrackEventRequest } from '@algominutes/contracts/schemas';

// POST /v1/events — A9.6 conversion-funnel tracking. Best-effort: a failed track
// must never break the user flow, so we log and still 202. Keep props PII-free.
export async function trackEventRoute(req, res) {
  // The published contract: a known funnel event and flat, primitive props.
  const parsed = TrackEventRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_event' });
  const { event, props, occurredAt } = parsed.data;
  try {
    await trackEvent({ uid: req.uid, event, props: props ?? null, occurredAt: occurredAt ?? null });
  } catch (err) {
    req.log.warn({ err, event }, 'analytics_track_failed');
  }
  return res.status(202).json({ ok: true });
}
