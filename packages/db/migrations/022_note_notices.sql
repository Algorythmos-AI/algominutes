-- 022: the "ready" and "failed" notices, written with the outcome they
-- announce, and a run counter to key them by. Expand-only (a new column with a
-- constant default, a new table, a partial index).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- The workers enqueued the notify task after their terminal transaction had
-- committed. A crash in between lost the push, and a replayed task could send
-- it twice. The short-recording fast path never enqueued one at all, and the
-- sweep's stuck-note failure and the summarizer's "no speech" failure told
-- nobody. Now the transaction that makes a note ready or failed also writes its
-- notice here (an outbox). The worker then enqueues a task named after the
-- notice, the notifier claims the row before sending and marks it sent, and the
-- sweep re-enqueues a notice left unsent.
--
-- One notice per (note, run, summary generation, kind): a replay of the same
-- outcome adds nothing, while a re-run (markQueued bumps run_seq) or a
-- regenerated summary (summary_generation) is a new outcome with its own.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS run_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS note_notices (
  id           BIGSERIAL PRIMARY KEY,
  -- A deleted note is never announced: its notices go with it.
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  uid          TEXT NOT NULL,         -- the note's author, who gets the push
  run_seq      INTEGER NOT NULL,
  generation   INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('note_ready', 'note_failed')),
  trace_id     TEXT,                  -- the recording's, so a re-enqueue stays followable
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at   TIMESTAMPTZ,           -- the notifier is sending it (a short lease)
  sent_at      TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,           -- still unsent after a day: given up, and logged
  UNIQUE (note_id, run_seq, generation, kind)
);

-- The sweep's read: notices not yet sent or given up.
CREATE INDEX IF NOT EXISTS note_notices_unsent_idx
  ON note_notices (created_at) WHERE sent_at IS NULL AND abandoned_at IS NULL;
