-- 013: resumable upload sessions, kept server-side. Expand-only (a new table).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- POST /v1/uploads used to hand the client an uploadId that WAS the session
-- (base64 JSON of the GCS session URI and storage path), and the status and
-- complete routes trusted whatever came back. So an authenticated caller could
-- make the server PUT to any URL (SSRF), and probe whether any storage path
-- existed, in any workspace. The session now lives here. The uploadId is this
-- row's random id, and every read is scoped to the caller's uid. Nothing the
-- client sends is used as a URL or a path again.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  uid           TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,  -- account deletion removes them
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id       TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  session_uri   TEXT NOT NULL,             -- minted by GCS, never taken from a client
  total_bytes   BIGINT NOT NULL CHECK (total_bytes >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL       -- GCS resumable sessions live 7 days
);

CREATE INDEX IF NOT EXISTS upload_sessions_uid_idx ON upload_sessions (uid);
CREATE INDEX IF NOT EXISTS upload_sessions_expires_idx ON upload_sessions (expires_at);
