-- 004_note_feedback.sql
-- Transcription-quality ratings.
--
-- A table rather than columns on `notes`. Workspaces are multi-member by
-- design, so a column could hold only one person's rating, and it would make
-- the notes row hot — every rating would rewrite a row that the pipeline is
-- also updating.
--
-- The primary key IS the idempotency: one rating per user, per note, per
-- kind, upserted with ON CONFLICT. Rating twice corrects the first rating
-- rather than accumulating duplicates.
--
-- `kind` is present so a later "summary quality" rating does not need another
-- table; today only 'transcription' is written.
--
-- `comment` is stored PII-redacted. The free-text box is exactly where a
-- user types "missed a name, John Smith, ID 12345". It
-- never reaches Gemini, but a human will read it and it would otherwise leak
-- into any future eval corpus. `redaction_counts` records what was masked,
-- mirroring the search_query_redacted precedent.
--
-- ON DELETE CASCADE on both FKs keeps the existing onNoteDeleted and
-- delete-account cascades correct with no code change.

BEGIN;

CREATE TABLE IF NOT EXISTS note_feedback (
  note_id          TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  uid              TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'transcription',
  rating           SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          TEXT,
  redaction_counts JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, uid, kind)
);

-- Supports "which notes are rated badly" without scanning: the question that
-- makes this data worth collecting.
CREATE INDEX IF NOT EXISTS note_feedback_rating_idx
  ON note_feedback(kind, rating, created_at DESC);

COMMIT;
