-- 001_init.sql
-- Wassup Meeting — initial Postgres schema.
--
-- Source-of-truth for queryable meeting data. Firestore continues to be
-- the live/realtime cache projection used by the SPA; every mutation
-- flows through lib/notes-repo.ts which writes Postgres first, then
-- mirrors hot fields to Firestore.
--
-- Required extensions are installed by 000_extensions.sql (run first).
-- The migrate.ts runner also installs them on first run.

BEGIN;

-- ────────────────────────────────────────────────────────────────────
-- Identity (mirrors Firebase Auth uid; we do NOT replace Firebase Auth)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  uid                TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  display_name       TEXT,
  photo_url          TEXT,
  plan               TEXT NOT NULL DEFAULT 'free',  -- free | pro | team (billing later)
  stripe_customer_id TEXT UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  owner_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uid          TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',     -- owner | admin | member | viewer
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, uid)
);
CREATE INDEX IF NOT EXISTS workspace_members_uid_idx ON workspace_members(uid);

-- ────────────────────────────────────────────────────────────────────
-- Recordings / Notes
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  title         TEXT,
  status        TEXT NOT NULL,                      -- queued|chunking|transcribing|summarizing|ready|error
  source_type   TEXT NOT NULL,                      -- recording|import_audio|import_pdf|youtube|scan_text|online_meeting
  source_url    TEXT,
  storage_path  TEXT,
  mime_type     TEXT,
  duration_sec  INTEGER,
  language      TEXT DEFAULT 'en',
  word_count    INTEGER,
  participants  JSONB,                              -- [{name,email,role}]
  meeting_at    TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ                         -- soft delete; TTL job hard-deletes after 30d
);
CREATE INDEX IF NOT EXISTS notes_workspace_created_idx
  ON notes(workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notes_status_idx ON notes(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS notes_author_idx ON notes(author_uid);
CREATE INDEX IF NOT EXISTS notes_participants_gin ON notes USING gin(participants);

CREATE TABLE IF NOT EXISTS audio_chunks (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  note_id            TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL,
  start_sec          NUMERIC NOT NULL,
  end_sec            NUMERIC NOT NULL,
  storage_path       TEXT NOT NULL,
  status             TEXT NOT NULL,                  -- pending|done|error
  stt_operation_id   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (note_id, idx)
);

CREATE TABLE IF NOT EXISTS transcript_lines (
  id            BIGSERIAL PRIMARY KEY,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_id      UUID REFERENCES audio_chunks(id) ON DELETE SET NULL,
  speaker_tag   INTEGER,                              -- diarization label (1, 2, ...)
  speaker_name  TEXT,                                 -- once user labels it
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  confidence    NUMERIC
);
CREATE INDEX IF NOT EXISTS transcript_lines_note_time_idx ON transcript_lines(note_id, start_ms);
CREATE INDEX IF NOT EXISTS transcript_lines_text_trgm
  ON transcript_lines USING gin(text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS summaries (
  note_id       TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  gist          TEXT,
  long_summary  TEXT,
  topics        JSONB,
  model         TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS action_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  assignee_uid    TEXT REFERENCES users(uid) ON DELETE SET NULL,
  assignee_name   TEXT,
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'open',       -- open|done|dropped
  source_line_id  BIGINT REFERENCES transcript_lines(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS action_items_note_idx ON action_items(note_id);
CREATE INDEX IF NOT EXISTS action_items_assignee_status_idx ON action_items(assignee_uid, status);

CREATE TABLE IF NOT EXISTS key_decisions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  source_line_id  BIGINT REFERENCES transcript_lines(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS key_decisions_note_idx ON key_decisions(note_id);

-- ────────────────────────────────────────────────────────────────────
-- Embeddings (pgvector) — semantic search + RAG-chat retrieval target
-- 768-dim matches Vertex text-embedding-004 output.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embeddings (
  id            BIGSERIAL PRIMARY KEY,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_text    TEXT NOT NULL,
  start_ms      INTEGER,
  end_ms        INTEGER,
  embedding     vector(768) NOT NULL,
  model         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS embeddings_workspace_idx ON embeddings(workspace_id);
CREATE INDEX IF NOT EXISTS embeddings_note_idx ON embeddings(note_id);
CREATE INDEX IF NOT EXISTS embeddings_hnsw
  ON embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ────────────────────────────────────────────────────────────────────
-- Sharing (table created now to avoid future migration; UI ships later)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shares (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  token           TEXT UNIQUE NOT NULL,
  permission      TEXT NOT NULL,                      -- view|comment
  password_hash   TEXT,
  expires_at      TIMESTAMPTZ,
  created_by_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
-- Subscriptions (defined now; activated when Stripe phase ships)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  uid                     TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  stripe_subscription_id  TEXT UNIQUE,
  plan                    TEXT NOT NULL,             -- free|pro|team
  status                  TEXT NOT NULL,             -- active|past_due|canceled|trialing
  current_period_end      TIMESTAMPTZ,
  seats                   INTEGER DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
-- Cost / usage attribution
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id             BIGSERIAL PRIMARY KEY,
  uid            TEXT REFERENCES users(uid) ON DELETE SET NULL,
  workspace_id   TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  note_id        TEXT REFERENCES notes(id) ON DELETE SET NULL,
  event          TEXT NOT NULL,                        -- gemini_call|stt_call|embedding_call|storage_bytes
  model          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  audio_seconds  NUMERIC,
  bytes          BIGINT,
  cost_usd       NUMERIC,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_events_uid_time_idx ON usage_events(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_workspace_time_idx ON usage_events(workspace_id, created_at DESC);

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename     TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
