-- 007: A9 billing groundwork (plans, usage_ledger) + A7.4 dead-letter queue.
--
-- EXPAND-ONLY (BUILD-PLAN §4.4): new tables + additive columns only; never edits
-- a committed migration. Safe to re-run (IF NOT EXISTS / ON CONFLICT).
--
-- NOTE on limits: the authoritative per-plan minute quota lives in config
-- (@algominutes/contracts limits.ts). The `plans` table mirrors it for FK / admin
-- / reporting; keep them in step (a config change is the source of truth).

-- ── plans: tier reference table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  plan_id                  TEXT PRIMARY KEY,            -- free | pro | team
  display_name             TEXT NOT NULL,
  monthly_included_minutes INTEGER,                     -- mirror of config; NULL = per-seat (team, P2)
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO plans (plan_id, display_name, monthly_included_minutes) VALUES
  ('free', 'Free', 120),
  ('pro',  'Pro',  1500),
  ('team', 'Team', NULL)
ON CONFLICT (plan_id) DO NOTHING;

-- ── subscriptions: additive seams (table exists in 001_init) ─────────
-- A9.4 dual-rail: which store/rail owns the subscription (entitlement is still
-- keyed to the user, never the rail).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS source TEXT;          -- stripe | apple_storekit | google_play
-- A9.3 trial-vs-free is an OPEN decision (see DECISIONS.md). This column is the
-- SEAM only: non-null iff a trial has been granted. Its presence does not decide
-- that trials will be used — a perpetual free tier simply never sets it.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end TIMESTAMPTZ;

-- ── usage_ledger: metered-minutes ledger (distinct from usage_events=COGS) ──
-- Append-only. Idempotent under Cloud Tasks replay (idempotency_key UNIQUE).
-- REVERSAL entries (A7.4) refund minutes on pipeline failure — a reversal row,
-- never a delete. Net consumption in a period = SUM(minutes): debit +, reversal -.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id               BIGSERIAL PRIMARY KEY,
  uid              TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  workspace_id     TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  note_id          TEXT REFERENCES notes(id) ON DELETE SET NULL,
  entry_type       TEXT NOT NULL,                       -- 'debit' | 'reversal'
  minutes          NUMERIC NOT NULL,                    -- debit: +minutes; reversal: -minutes
  billing_period   TEXT NOT NULL,                       -- 'YYYY-MM' (UTC) monthly window
  reason           TEXT,                                -- 'ingest' | 'refund:transcode_failed' | ...
  reverses_id      BIGINT REFERENCES usage_ledger(id),  -- set on reversal entries
  idempotency_key  TEXT NOT NULL UNIQUE,                -- append is a no-op on replay
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT usage_ledger_entry_type_chk CHECK (entry_type IN ('debit', 'reversal'))
);
CREATE INDEX IF NOT EXISTS usage_ledger_uid_period_idx ON usage_ledger(uid, billing_period);
CREATE INDEX IF NOT EXISTS usage_ledger_note_idx ON usage_ledger(note_id);

-- ── dead_letter: A7.4 DLQ + admin view ──────────────────────────────
-- Cloud Tasks has no native DLQ; on the FINAL attempt a worker writes the
-- exhausted job here so it is never silently lost and an admin can see/replay it.
-- Payload is job METADATA only (noteId/workspaceId/kind) — never transcript/PII.
CREATE TABLE IF NOT EXISTS dead_letter (
  id             BIGSERIAL PRIMARY KEY,
  queue          TEXT NOT NULL,                         -- transcode|summarize|embed|extract|notify
  note_id        TEXT,
  workspace_id   TEXT,
  payload        JSONB,                                 -- job metadata only, no PII
  error          TEXT,
  attempts       INTEGER,
  trace_id       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,                           -- admin marks replayed/resolved
  resolved_by    TEXT
);
CREATE INDEX IF NOT EXISTS dead_letter_unresolved_idx
  ON dead_letter(queue, created_at DESC) WHERE resolved_at IS NULL;
