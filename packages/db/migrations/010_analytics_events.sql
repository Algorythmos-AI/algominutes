-- 010: A9.6 conversion analytics sink. Expand-only.
-- The trial-end → paywall-viewed → purchase funnel that tells us if 7 days is right.
-- Cloud Logging works too, but a table is queryable for funnel analysis. No PII in props.
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  uid         TEXT REFERENCES users(uid) ON DELETE SET NULL,
  event       TEXT NOT NULL,       -- AnalyticsEvent (@algominutes/contracts)
  props       JSONB,               -- small, no PII (no transcript/audio/email)
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS analytics_events_event_time_idx ON analytics_events(event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_uid_idx ON analytics_events(uid);
