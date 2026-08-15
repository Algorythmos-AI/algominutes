import { trackEvent } from '@algominutes/db';

// POST /v1/events — A9.6 conversion-funnel tracking. Best-effort: a failed track
// must never break the user flow, so we log and still 202. Keep props PII-free.
export async function trackEventRoute(req, res) {
  const { event, props, occurredAt } = req.body || {};
  if (!event || typeof event !== 'string') {
    return res.status(400).json({ error: 'event_required' });
  }
  try {
    await trackEvent({ uid: req.uid, event, props: props ?? null, occurredAt: occurredAt ?? null });
  } catch (err) {
    req.log.warn({ err, event }, 'analytics_track_failed');
  }
  return res.status(202).json({ ok: true });
}
