-- 005_regen_and_templates.sql
-- Columns for summary templates and for regenerating a summary safely.
--
-- All four are additive and nullable-or-defaulted, so ADD COLUMN is a
-- metadata-only operation on PG 11+ (no table rewrite) and safe on a live
-- notes table.
--
-- summary_template        which prompt variant produced the current summary,
--                         and which to use on the next run.
-- summary_generation      monotonic counter. Passed in the summarizer task
--                         payload; the handler re-reads it and declines to
--                         write if it no longer matches, so a replayed old
--                         Cloud Task cannot clobber a newer run.
-- summary_requested_at    when a regenerate was claimed. Also the stale-lock
--                         takeover clock, so a summarizer that dies mid-run
--                         cannot strand a note in 'summarizing' forever.
-- summary_manually_edited_at
--                         set whenever a user edits the summary through
--                         /api/update-note. Regenerate refuses to overwrite a
--                         non-null value without explicit confirmation —
--                         reprocessing silently wiping manual edits is the
--                         reason /api/update-note exists at all.

BEGIN;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_template TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_requested_at TIMESTAMPTZ;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_manually_edited_at TIMESTAMPTZ;

COMMIT;
