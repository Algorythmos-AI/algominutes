-- 021: an index for the spend cap's reader. Expand-only (a new index).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- The transcoder now records paid work in usage_events as it starts, and the
-- daily spend cap (spend-repo.cjs) sums the last 24 hours of it, once a minute
-- per instance. The existing indexes lead with uid or workspace_id, so that
-- read scanned the whole table, and nothing deletes rows. The table is empty
-- until this ships (nothing wrote it before), so a plain CREATE INDEX is instant.
CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events(created_at);
