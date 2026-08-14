-- 003_transcript_keyset_index.sql
-- Covering index for keyset pagination over a note's transcript.
--
-- /api/note pages the full transcript with a keyset cursor rather than
-- OFFSET, because a 2-hour chunked meeting is 3-6k lines and later pages
-- degrade badly under OFFSET. The cursor predicate is
--
--   WHERE note_id = $1 AND (start_ms, id) > ($2, $3)
--   ORDER BY start_ms, id
--
-- The pre-existing transcript_lines_note_time_idx covers (note_id, start_ms)
-- only. That is not merely a performance gap, it is a correctness one:
-- the fast Gemini path inserts `start_ms || 0` (services/transcoder/src/
-- fast-path.js), so every line whose model-supplied timestamp failed to
-- parse lands on start_ms = 0. Ordering by start_ms alone across a page
-- boundary is therefore non-deterministic and pages can silently skip or
-- duplicate rows. The id tiebreak fixes ordering; this index makes the
-- tiebreak indexable instead of a sort.
--
-- id is BIGSERIAL, so within a note it ascends in insertion order — which
-- is transcript order for the fast path, and chunk-then-idx order for the
-- chunked path. Both are stable, which is all the cursor requires.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because the house convention wraps
-- migrations in BEGIN/COMMIT and CONCURRENTLY cannot run inside a
-- transaction block. At the current corpus size this is a sub-second lock.
-- If transcript_lines ever reaches a size where that matters, build the
-- replacement CONCURRENTLY outside a transaction and drop this one.

BEGIN;

CREATE INDEX IF NOT EXISTS transcript_lines_note_keyset_idx
  ON transcript_lines(note_id, start_ms, id);

COMMIT;
