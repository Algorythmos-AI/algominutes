-- 024: who may use the online-meeting notetaker while it's in testing
-- (docs/plans/MEETINGS.md; docs/CONSENT.md §2.4: allowlisted testers only until
-- the legal opinion). Expand-only: one new table.
--
-- Granted and revoked by the owner through the db-job `grant-notetaker`
-- handler, never by a client, so no tester's identity is ever in git (the same
-- rule as entitlement_grants, 019). The api reads it for GET /v1/config and
-- before sending a notetaker.
CREATE TABLE IF NOT EXISTS notetaker_testers (
  uid         TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  reason      TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ                 -- NULL = until revoked
);
