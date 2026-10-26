-- RELEASE.md PR 21: one run of a periodic job at a time, without holding a connection. The Recall purge
-- worker held a pooled connection for its whole run, to keep a session-level advisory lock, while its own
-- queries needed another: on a pool of one (meetings on staging) it waited on itself for ever. A lease row
-- is taken and released with one short query each, and expires by itself if a run dies. Expand-only: a new
-- table.
CREATE TABLE IF NOT EXISTS job_leases (
  name          TEXT PRIMARY KEY,
  holder        TEXT NOT NULL,
  locked_until  TIMESTAMPTZ NOT NULL
);
