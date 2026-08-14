-- 006_shares_hardening.sql
-- Make the dead `shares` table safe to activate.
--
-- 001_init.sql defined it in 2026-04 and nothing ever referenced it. As
-- written it is not safe to switch on:
--
--   token       TEXT UNIQUE NOT NULL   -- PLAINTEXT: a DB read yields live grants
--   expires_at  TIMESTAMPTZ            -- NULLABLE: a link with no expiry
--   (no revoked_at)                    -- no way to withdraw access
--   (no scope)                         -- all-or-nothing content
--
-- This migration fixes all four and adds an access log. Additive and
-- idempotent; the old `token` column is dropped only after `token_hash` is in
-- place, and the table is empty in production so there is nothing to migrate.
--
-- Never edit a committed migration (CLAUDE.md §8) — 001 stays as it is.

BEGIN;

-- Store sha256(token) only. Reading the database must never yield a working
-- link: the raw token is returned once, at mint time, and never persisted.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- Withdraw access without deleting the row, so the audit trail survives.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- summary | transcript | both — mirrors ExportScope so one vocabulary covers
-- export and sharing.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'both';

ALTER TABLE shares ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS read_count INTEGER NOT NULL DEFAULT 0;

-- The table has never been written to, so there are no plaintext tokens to
-- migrate. Guard anyway: refuse rather than silently drop live grants if this
-- ever runs somewhere the assumption does not hold.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM shares;
  IF n > 0 THEN
    RAISE EXCEPTION 'shares is not empty (% rows) — migrate token -> token_hash before dropping', n;
  END IF;
END $$;

ALTER TABLE shares DROP COLUMN IF EXISTS token;

-- Now that no rows exist, both constraints can be enforced from the start.
ALTER TABLE shares ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE shares ALTER COLUMN expires_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shares_token_hash_key ON shares(token_hash);
-- The read path looks up by hash and filters on revoked/expiry; the list path
-- fetches a note's links newest-first.
CREATE INDEX IF NOT EXISTS shares_note_created_idx ON shares(note_id, created_at DESC);

-- Who opened a link and when. Kept separate from `shares` so a hot read path
-- appends rather than updating the grant row on every request.
--
-- ip_hash, never a raw IP: enough to spot enumeration, not enough to build a
-- location history of whoever a clinician shared a consult with.
CREATE TABLE IF NOT EXISTS share_access_log (
  id          BIGSERIAL PRIMARY KEY,
  share_id    UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ip_hash     TEXT,
  user_agent  TEXT,
  outcome     TEXT NOT NULL,           -- ok | expired | revoked | not_found
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS share_access_log_share_idx ON share_access_log(share_id, read_at DESC);
CREATE INDEX IF NOT EXISTS share_access_log_outcome_idx ON share_access_log(outcome, read_at DESC);

COMMIT;
