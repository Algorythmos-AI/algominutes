/**
 * analytics_events repo (A9.6). Records the conversion funnel. Keep `props` small
 * and PII-free (no transcript/audio/email) — this is aggregate product analytics.
 */
import { getPool, isPostgresEnabled } from './db.js';

export async function trackEvent(input: {
  uid?: string | null;
  event: string;
  props?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `INSERT INTO analytics_events (uid, event, props, occurred_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))`,
    [input.uid ?? null, input.event, input.props ? JSON.stringify(input.props) : null, input.occurredAt ?? null],
  );
}
