-- 017: a note purge also cancels the note's open upload sessions. Expand-only
-- (a new column with a default).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- Deleting a note deletes its upload_sessions rows, but a GCS resumable-session
-- URI stays valid for a week. A client still holding one could finish the
-- upload after the delete and leave an object behind. deleteNote now records
-- the URIs here, in its transaction, and the purge cancels them before it
-- deletes the note's objects (so an upload that landed first is removed too).
-- Account deletion keeps its own list on the tombstone (016).
ALTER TABLE storage_purges ADD COLUMN IF NOT EXISTS upload_session_uris TEXT[] NOT NULL DEFAULT '{}';
