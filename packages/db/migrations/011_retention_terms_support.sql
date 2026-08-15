-- 011: A10 launch blockers — data retention (#5), timestamped terms/privacy
-- acceptance at signup (#3), and in-app support requests (#4). Expand-only.

-- ── Data retention (A10 #5) ──────────────────────────────────────────────────
-- User-set retention. NULL = the product default (see DATA-RETENTION.md). A
-- scheduled purge deletes notes whose age exceeds this; deletion then propagates
-- to backups within the stated window (A11 backup-lifecycle config).
ALTER TABLE users ADD COLUMN IF NOT EXISTS retention_days INTEGER;

-- ── Terms + Privacy acceptance (A10 #3) ──────────────────────────────────────
-- Timestamped, versioned acceptance captured at signup (and re-accept on version
-- bump). Append-only history so we can prove what a user agreed to and when.
CREATE TABLE IF NOT EXISTS terms_acceptance (
  id              BIGSERIAL PRIMARY KEY,
  uid             TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  terms_version   TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_hash         TEXT,           -- hashed, never a raw IP
  app_version     TEXT,
  platform        TEXT            -- ios | android | web
);
CREATE INDEX IF NOT EXISTS terms_acceptance_uid_idx ON terms_acceptance(uid, accepted_at DESC);

-- ── In-app support requests (A10 #4) ─────────────────────────────────────────
-- Diagnostic context ONLY — app version, device, note id. NEVER audio or
-- transcript/summary content (enforced by the api route's allowlist).
CREATE TABLE IF NOT EXISTS support_requests (
  id           BIGSERIAL PRIMARY KEY,
  uid          TEXT REFERENCES users(uid) ON DELETE SET NULL,
  kind         TEXT NOT NULL,          -- contact | bad_transcript | bad_summary
  message      TEXT,                   -- user's words (no attached content)
  note_id      TEXT,                   -- reference only, not the content
  app_version  TEXT,
  device       TEXT,
  platform     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS support_requests_unresolved_idx
  ON support_requests(created_at DESC) WHERE resolved_at IS NULL;
