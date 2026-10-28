-- Plan rev 12 S7: the sweep's mirror repair pages its window newest first, and a run cut off by its time
-- budget used to forget where it stopped, so notes in the middle that consecutive cut-off runs never
-- reached went unchecked. One row: the (updated_at, id) watermark a cut-off run stopped at, which the next
-- run resumes from after its own newest-first pass (packages/db mirror-repair.ts). No row: nothing to
-- resume. Expand-only: a new table, which old images never read.
CREATE TABLE IF NOT EXISTS mirror_repair_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  updated_at timestamptz NOT NULL,
  note_id text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT NOW()
);
