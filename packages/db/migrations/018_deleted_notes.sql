-- 018: a tombstone per deleted note. Expand-only (a new table).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- A deleted note's storage_purges row (014) goes once its doc and objects are
-- gone. After that nothing remembered the deletion, so a stale client (an
-- offline device resuming its upload) could mint a new upload session for the
-- note and leave an object in the bucket that nothing processes or deletes.
-- deleteNote and account deletion now write a row here in their transaction,
-- and createUploadSession and the kickoff refuse a note that has one. The
-- sweeper prunes rows after 30 days (DATA-RETENTION.md). Ids only, no content.
--
-- No foreign key to notes: the note row is already gone.
CREATE TABLE IF NOT EXISTS deleted_notes (
  note_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS deleted_notes_deleted_at_idx ON deleted_notes (deleted_at);
