-- RELEASE.md rev 11, L2 (H2d): an upload that no note followed is found. The apps upload, then ask /v1/process
-- to run the note; an app killed between the two left the audio in Cloud Storage and no note row, so nothing
-- server-side saw it. /complete stamps completed_at; the sweep reports an upload completed 30 minutes ago with
-- no note, once (stranded_reported_at). Expand-only: two nullable columns and a partial index.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS stranded_reported_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS upload_sessions_unreported_idx
  ON upload_sessions (completed_at) WHERE completed_at IS NOT NULL AND stranded_reported_at IS NULL;
