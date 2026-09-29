-- RELEASE.md PR 30a (audit Q20): the sweep's mirror repair pages through every note that finished in its
-- window by an (updated_at, id) watermark, where it used to stop at 200 and scan the notes table to find
-- them. A partial index on the finished notes, the only rows it reads. Expand-only: a new index. Plain
-- CREATE INDEX (not CONCURRENTLY), as the migrator wraps each migration in a transaction.
CREATE INDEX IF NOT EXISTS notes_finished_updated_idx
  ON notes (updated_at, id)
  WHERE status IN ('ready', 'error') AND deleted_at IS NULL;
