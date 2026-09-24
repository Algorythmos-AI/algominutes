-- 014: a durable queue of note audio to delete from Cloud Storage. Expand-only
-- (a new table).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- Deleting a note used to depend on the functions/ Firestore trigger
-- onNoteDeleted for both the Postgres rows and the audio. The new pipeline
-- never deploys that trigger, so a deleted note's transcript stayed searchable
-- and its audio stayed in the bucket. notesRepo.deleteNote now deletes the
-- Postgres rows itself, and in the SAME transaction records here what must be
-- removed from storage. The api purges it right away, and a row is deleted
-- only once its objects are gone, so a failed or interrupted purge is retried
-- (by the PR-15 sweeper) rather than lost.
--
-- No foreign key to notes: the note row is already gone when this is read.
CREATE TABLE IF NOT EXISTS storage_purges (
  id            BIGSERIAL PRIMARY KEY,
  note_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  storage_path  TEXT,                      -- the note's own object, when it had one
  -- The transcoder's scratch (transcoder/{noteId}/) is keyed by note id alone,
  -- so it is purged only when this deletion proves the id was this
  -- workspace's (its row was deleted here, or the id exists nowhere).
  include_scratch BOOLEAN NOT NULL DEFAULT FALSE,
  trace_id      TEXT,                      -- the deleting request, for one-id tracing
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS storage_purges_created_idx ON storage_purges (created_at);
