-- 020: a summary's chapters. Expand-only (a new column with a default).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- A 2-4 hour recording needs sections to be usable: the summarizer now asks the
-- model for chapters on anything past 10 minutes, each a start time in the
-- recording, a title and a one-line summary (summary-output.cjs validates them).
-- Stored with the summary they belong to, replaced whenever it is, and mirrored
-- to the note doc's summary.chapters. '[]' means none (a short note, or an
-- older summary).
ALTER TABLE summaries ADD COLUMN IF NOT EXISTS chapters JSONB NOT NULL DEFAULT '[]'::jsonb;
