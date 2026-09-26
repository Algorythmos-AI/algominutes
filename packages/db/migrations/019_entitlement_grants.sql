-- 019: a manual entitlement grant per user, for internal testers. Expand-only
-- (a new table).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- Staging testers had no way to process a recording: FREE_FLOOR_MINUTES is
-- unset (0 minutes), and a TestFlight build without a DeviceCheck token gets no
-- trial, so the first /v1/process answered 402. A grant makes resolveEntitlement
-- treat the user as on a paid plan (a real paid subscription still wins). The
-- owner adds one with the db-job `grant-tester` handler; tester emails never go
-- into git. The grant goes with the account (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS entitlement_grants (
  uid              TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  -- Only Pro: team's monthly minutes are unmetered, so a team grant (even one
  -- inserted by hand) would be unlimited processing cost.
  plan             TEXT NOT NULL CHECK (plan = 'pro'),
  included_minutes INTEGER CHECK (included_minutes IS NULL OR included_minutes > 0), -- NULL = the plan's monthly minutes
  reason           TEXT NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ                 -- NULL = until revoked
);
