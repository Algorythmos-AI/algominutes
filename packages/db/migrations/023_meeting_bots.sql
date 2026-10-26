-- 023: the online-meeting notetaker (docs/plans/MEETINGS.md, M1). Expand-only:
-- two nullable columns on notes, and new tables.
--
-- A notetaker is a Recall.ai bot one user sends to one meeting. Its recording
-- becomes one note in that user's workspace, and nobody else's (CLAUDE.md
-- multi-tenancy). Every table below is written only through
-- packages/db/src/meetings-repo.ts. The uniques are what make Recall's webhooks
-- (delivered at least once, in any order) and Cloud Tasks replays harmless.

-- How a note's audio arrived, and the meeting platform. Nullable: every note
-- before this migration is a device recording or an upload.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS source_kind TEXT;   -- device|upload|bot|extension|cloud_import
ALTER TABLE notes ADD COLUMN IF NOT EXISTS platform TEXT;      -- google_meet|zoom|teams|webex|other

CREATE TABLE IF NOT EXISTS meeting_bots (
  -- Ours. Also Recall's Idempotency-Key and metadata.meeting_bot_id, so a
  -- replayed create can find and adopt the bot it already made.
  id                   UUID PRIMARY KEY,
  uid                  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The note the recording becomes. A deleted note leaves the bot row (its
  -- Recall media purge still has to run); it just points nowhere.
  note_id              TEXT UNIQUE REFERENCES notes(id) ON DELETE SET NULL,
  -- Set by deleteNote in its transaction, before the row goes (and note_id with
  -- it): the bot's note was deleted, so a replayed task must never create it
  -- again, even after the deletion tombstones are pruned.
  note_deleted_at      TIMESTAMPTZ,
  recall_bot_id        TEXT UNIQUE,
  -- The client's idempotency key for a pasted link, or the calendar event (M2).
  client_request_id    TEXT,
  calendar_event_id    TEXT,
  platform             TEXT NOT NULL,
  -- sha256 of the normalised meeting URL: for de-duplication, safe to log. The
  -- URL itself (Zoom's pwd=, Teams tokens) is kept only encrypted, and only
  -- until the bot has joined.
  meeting_url_hash     TEXT NOT NULL,
  meeting_url_ciphertext BYTEA,
  status               TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                         'requested', 'scheduled', 'joining', 'waiting_room', 'in_call', 'recording',
                         'call_ended', 'processing', 'done', 'failed', 'cancelled')),
  -- Webhooks arrive out of order: a status only ever moves forward, and the
  -- three terminal ones never change.
  status_rank          INTEGER NOT NULL DEFAULT 0,
  failure_reason       TEXT,
  cancel_requested     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Notetaker minutes held for this meeting when it was sent, released on
  -- failure or cancel, settled to the recording's length at ingest.
  reserved_minutes     INTEGER NOT NULL DEFAULT 0 CHECK (reserved_minutes >= 0),
  billable_seconds     INTEGER CHECK (billable_seconds >= 0),
  recording_started_at TIMESTAMPTZ,
  recording_ended_at   TIMESTAMPTZ,
  audio_ready_at       TIMESTAMPTZ,       -- audio_mixed.done
  participants_ready_at TIMESTAMPTZ,      -- participant_events.done
  ingested_at          TIMESTAMPTZ,
  recall_media_deleted_at TIMESTAMPTZ,
  trace_id             TEXT,              -- the request that sent it: one id across every hop
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One bot per client request, per workspace.
  UNIQUE (workspace_id, client_request_id)
);

-- While a bot is live, a workspace can't send a second one to the same meeting
-- or calendar event. Another workspace can: its user gets their own bot and
-- note (never a share of this one).
CREATE UNIQUE INDEX IF NOT EXISTS meeting_bots_active_url_uq
  ON meeting_bots (workspace_id, meeting_url_hash)
  WHERE status NOT IN ('done', 'failed', 'cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS meeting_bots_active_event_uq
  ON meeting_bots (workspace_id, calendar_event_id)
  WHERE calendar_event_id IS NOT NULL AND status NOT IN ('done', 'failed', 'cancelled');
-- The quota and concurrency reads, and the reconcile sweep's.
CREATE INDEX IF NOT EXISTS meeting_bots_uid_created_idx ON meeting_bots (uid, created_at DESC);
CREATE INDEX IF NOT EXISTS meeting_bots_active_idx
  ON meeting_bots (updated_at) WHERE status NOT IN ('done', 'failed', 'cancelled');

-- Every Recall webhook, as received. The unique webhook id makes a redelivery a
-- no-op. meeting_bot_id is NULL when it arrived before our row knew the bot (it
-- is reconciled). Pruned by the sweep after 30 days.
CREATE TABLE IF NOT EXISTS recall_events (
  id             BIGSERIAL PRIMARY KEY,
  webhook_id     TEXT NOT NULL UNIQUE,
  meeting_bot_id UUID REFERENCES meeting_bots(id) ON DELETE CASCADE,
  recall_bot_id  TEXT,
  event          TEXT NOT NULL,
  sub_code       TEXT,
  occurred_at    TIMESTAMPTZ,
  payload        JSONB NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS recall_events_bot_idx ON recall_events (meeting_bot_id, received_at);
CREATE INDEX IF NOT EXISTS recall_events_unprocessed_idx ON recall_events (received_at) WHERE processed_at IS NULL;

-- The people in the meeting, by Recall's participant id. Display names only
-- (participant emails are off): they are the note's speaker names, deleted
-- with the bot.
CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_bot_id        UUID NOT NULL REFERENCES meeting_bots(id) ON DELETE CASCADE,
  recall_participant_id TEXT NOT NULL,
  speaker_tag           INTEGER NOT NULL CHECK (speaker_tag >= 1),   -- 1..N, in order of first speech
  display_name          TEXT NOT NULL,
  PRIMARY KEY (meeting_bot_id, recall_participant_id),
  UNIQUE (meeting_bot_id, speaker_tag)
);

-- Who spoke when, from Recall's speaker timeline, in ms from the recording's
-- start. Replaced in one transaction per ingest; goes with the note.
CREATE TABLE IF NOT EXISTS meeting_speaker_segments (
  note_id     TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms      INTEGER NOT NULL,
  speaker_tag INTEGER NOT NULL CHECK (speaker_tag >= 1),
  PRIMARY KEY (note_id, seq),
  CHECK (end_ms >= start_ms)
);

-- What the meeting was told (docs/CONSENT.md §2.4): the notice's version, when
-- it was posted, whether the bot was admitted, and the host's recording answer.
CREATE TABLE IF NOT EXISTS meeting_consents (
  meeting_bot_id       UUID PRIMARY KEY REFERENCES meeting_bots(id) ON DELETE CASCADE,
  notice_version       TEXT NOT NULL,
  notice_sent_at       TIMESTAMPTZ,
  admitted_at          TIMESTAMPTZ,
  recording_permission TEXT CHECK (recording_permission IN ('allowed', 'denied'))
);

-- Recall's copy of a recording, to delete (its DELETE media call, then the
-- recording.deleted confirmation). Written in the same transaction that deletes
-- a note or an account, or by ingest once our copy is safe; retried by the
-- sweep. No foreign keys: it must outlive the bot, the note and the account.
CREATE TABLE IF NOT EXISTS recall_purges (
  id            BIGSERIAL PRIMARY KEY,
  recall_bot_id TEXT NOT NULL UNIQUE,
  reason        TEXT NOT NULL CHECK (reason IN ('ingested', 'note_deleted', 'account_deleted', 'failed')),
  -- Also leave the call first (a note deleted while its bot is still in it).
  leave_call    BOOLEAN NOT NULL DEFAULT FALSE,
  trace_id      TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at  TIMESTAMPTZ,              -- recording.deleted received
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recall_purges_pending_idx ON recall_purges (requested_at) WHERE confirmed_at IS NULL;
