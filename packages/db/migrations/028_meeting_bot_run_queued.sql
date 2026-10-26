-- RELEASE.md PR 19: a notetaker's run is queued once per bot. markQueued stamps run_queued_at in the
-- transaction that queues the run, under the note's lock, so an ingest replayed after the run has finished
-- never queues it again (a second paid run). The kickoff's own failure clears it (markError), so the
-- task's retry queues it. Expand-only: a nullable column.
ALTER TABLE meeting_bots ADD COLUMN IF NOT EXISTS run_queued_at TIMESTAMPTZ;
