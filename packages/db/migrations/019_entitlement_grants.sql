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
  plan             TEXT NOT NULL,              -- a PlanId; only 'pro' is granted (team is unmetered)
  included_minutes INTEGER,                    -- NULL = the plan's monthly minutes
  reason           TEXT NOT NULL,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ                 -- NULL = until revoked
);
