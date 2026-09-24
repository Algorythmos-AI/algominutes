-- 016: a tombstone per deleted account. Expand-only (a new table).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- POST /v1/account/delete removes the users row first, then Firestore, storage
-- and Auth. Two things need a record that outlives the users row:
--   * A retry after a partial failure must know which workspaces the account
--     owned, and they are gone from Postgres by then.
--   * A still-valid ID token (up to an hour) must not quietly re-create the
--     account: ensureUser refuses a uid that has a tombstone.
-- Only the uid and its workspace ids are kept, not content. completed_at
-- marks the end. The sweeper may prune completed rows once no token issued
-- before the deletion can still be valid.
CREATE TABLE IF NOT EXISTS account_deletions (
  uid            TEXT PRIMARY KEY,
  workspace_ids  TEXT[] NOT NULL DEFAULT '{}',
  trace_id       TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
