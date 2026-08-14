-- 002_chunked_pipeline.sql
-- Phase 3: long-audio pipeline support.
--
-- The chunked transcoder writes transcript_lines per audio chunk via
-- Cloud Tasks; tasks can replay, so we need (chunk_id, idx) idempotency.
-- The fast Gemini path (chunk_id IS NULL) keeps using delete-then-insert
-- per note as before.
--
-- Two timestamp columns on notes serve as exactly-once enqueue gates:
-- the chunk-completion handler runs `UPDATE ... WHERE col IS NULL
-- RETURNING id` to claim the right to dispatch the next stage.

BEGIN;

-- Per-chunk index for ON CONFLICT idempotency on Cloud Task replays.
ALTER TABLE transcript_lines
  ADD COLUMN IF NOT EXISTS idx INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS transcript_lines_chunk_idx_uidx
  ON transcript_lines(chunk_id, idx)
  WHERE chunk_id IS NOT NULL;

-- Exactly-once dispatch gates from the chunk-completion path.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS summarizer_enqueued_at TIMESTAMPTZ;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS embedder_enqueued_at TIMESTAMPTZ;

-- Probed audio duration (ffprobe in transcoder). Informational; helps
-- ops triage stuck jobs and is the input to the fast/chunked routing.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS duration_sec_probed NUMERIC;

-- Chunk progress mirror so JobStatus can render N/M without a join.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS chunks_total INTEGER;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS chunks_done INTEGER NOT NULL DEFAULT 0;

COMMIT;
