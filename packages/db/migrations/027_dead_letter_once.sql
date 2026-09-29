-- 027_dead_letter_once.sql — one dead letter per lost piece of work (RELEASE.md PR 5a; audit Q2–Q4, Q7).
--
-- A replayed last attempt, a re-driven poll or a crash between a failure's
-- commit and its dead letter each wrote a second row (or none). Now:
--   - dedupe_key = queue:note:run_seq:chunk. The same queue's work on the same
--     run (and chunk) is one row, whichever attempt or path records it; a new
--     run of the note gets its own. The reason isn't in the key: a re-drive
--     says chunk_already_failed where the first said stt_poll_exhausted, and
--     they're the same loss (Q4). NULL when the note can't be read (gone, or
--     an old image's row): such rows are still written, never deduped (Q3).
--   - reason: why, as a stable code (stt_poll_exhausted, transcode_failed...),
--     apart from the error text (Q7).
--
-- Two nullable columns and a partial unique index. Existing rows keep a NULL
-- key. A rollback leaves them unused.
-- contract: the unique index is on dedupe_key, which this migration adds: every existing row's is NULL and the partial index skips NULLs, and an older image never sets it, so nothing serving can violate it
ALTER TABLE dead_letter ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE dead_letter ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS dead_letter_dedupe_key_uniq
  ON dead_letter (dedupe_key) WHERE dedupe_key IS NOT NULL;
