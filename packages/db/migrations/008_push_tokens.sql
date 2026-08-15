-- 008: FCM/APNs push registration tokens (A7.3). Expand-only.
-- The notifier looks these up to fan out "notes ready" / failure pushes; the api
-- register-push-token endpoint upserts them. No PII — just device tokens.
CREATE TABLE IF NOT EXISTS push_tokens (
  token       TEXT PRIMARY KEY,
  uid         TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  platform    TEXT NOT NULL,            -- ios | android | web
  app_version TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_tokens_uid_idx ON push_tokens(uid);
