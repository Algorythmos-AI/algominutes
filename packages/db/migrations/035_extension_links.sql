-- 035: one-time codes that sign the browser extension in (docs/plans/RELEASE.md
-- PR 34, docs/decisions/0002-chrome-extension.md §3). Expand-only: one new table.

-- ── Why ──────────────────────────────────────────────────────────────────────
-- The extension never asks for a password or runs its own OAuth. The signed-in
-- web app asks the api for a code bound to the user, the extension's id and the
-- SHA-256 of a verifier only the extension holds (PKCE's S256), and hands the
-- code to the extension, which trades the code and the verifier for a Firebase
-- custom token.
--
-- Only the code's SHA-256 is stored, never the code. A code lives 60 seconds and
-- is spent by the first attempt to trade it, right or wrong, so a code seen by
-- anyone else is dead as soon as they try it. Rows go with the account.
CREATE TABLE IF NOT EXISTS extension_links (
  code_hash     TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  uid           TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  -- Chrome's and Edge's extension ids: 32 letters a-p.
  extension_id  TEXT NOT NULL CHECK (extension_id ~ '^[a-p]{32}$'),
  -- base64url(SHA-256(verifier)), no padding: 43 characters.
  verifier_hash TEXT NOT NULL CHECK (verifier_hash ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A user's own spent and expired codes are cleared when they ask for a new one.
CREATE INDEX IF NOT EXISTS extension_links_uid ON extension_links (uid);
