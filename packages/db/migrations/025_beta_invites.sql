-- 025: beta invite codes (docs/plans/RELEASE.md, PR 2). Expand-only: two new
-- tables.

-- ── Why ──────────────────────────────────────────────────────────────────────
-- External beta testers need recording minutes without the owner running a
-- grant job per person. A tester enters the code from their invitation in the
-- app; redeeming it gives them a time-limited Pro grant (entitlement_grants,
-- 019), and, when the invite says so, the notetaker (notetaker_testers, 024).
--
-- Only a code's SHA-256 is stored, never the code: it's generated on the
-- owner's machine (scripts/new-invite-code.sh, 75 random bits) and passed to
-- the db-job `beta-invite` handler, so it's never in git, a log or this table.
CREATE TABLE IF NOT EXISTS beta_invites (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code_hash        TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  label            TEXT NOT NULL,                  -- the owner's note, e.g. "cohort 1"
  -- NULL = Pro's monthly minutes. Bounded, so a typo can't grant a fortune.
  included_minutes INTEGER CHECK (included_minutes IS NULL OR included_minutes BETWEEN 1 AND 10000),
  grant_days       INTEGER NOT NULL CHECK (grant_days BETWEEN 1 AND 365),
  max_redemptions  INTEGER NOT NULL CHECK (max_redemptions BETWEEN 1 AND 1000),
  redemptions      INTEGER NOT NULL DEFAULT 0,
  notetaker        BOOLEAN NOT NULL DEFAULT FALSE, -- also allowlist the notetaker (024)
  expires_at       TIMESTAMPTZ,                    -- the code stops working; NULL = never
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (redemptions BETWEEN 0 AND max_redemptions)
);

-- One row per (invite, user): a second redemption by the same user is a replay,
-- not another use. It goes with the account; the use it consumed stays counted.
CREATE TABLE IF NOT EXISTS beta_invite_redemptions (
  invite_id   UUID NOT NULL REFERENCES beta_invites(id) ON DELETE CASCADE,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (invite_id, uid)
);
CREATE INDEX IF NOT EXISTS beta_invite_redemptions_uid ON beta_invite_redemptions (uid);
