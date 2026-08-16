-- 012: per-note speaker names for diarisation (Bug 17 / ADR 0005). Expand-only.

-- ── Speaker rename map (diarisation §4) ──────────────────────────────────────
-- Whole-file diarisation assigns each turn a globally-consistent speaker_tag
-- (1, 2, …) on transcript_lines. This map lets a user rename "Speaker 2" once
-- and have every line re-label, WITHOUT rewriting speaker_name on every line:
-- note-read resolves display name as note_speakers.display_name → embedded
-- fast-path prefix → "Speaker N". Keyed on (note_id, speaker_tag), which is
-- exactly the join transcript_lines needs. Per-note only for v1 — cross-note
-- learned names (voiceprints) are deferred (privacy stance not taken at launch).
CREATE TABLE IF NOT EXISTS note_speakers (
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  speaker_tag  INTEGER NOT NULL,          -- matches transcript_lines.speaker_tag
  display_name TEXT NOT NULL,             -- user-entered name for this speaker
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, speaker_tag)
);
