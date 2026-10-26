-- RELEASE.md rev 11, L6 (H2b): a chunk's speech job is started by one attempt only. A long kickoff can be
-- delivered again while its first attempt is still running (the transcoder's 3600 s timeout outlives the
-- 1800 s dispatch deadline), and both attempts read "no operation yet" for the same chunk and both started,
-- and paid for, a job. The attempt that starts a chunk's job claims it first; a claim older than two minutes
-- (an attempt that died before saving its operation id) can be taken over. Expand-only: a nullable column.
ALTER TABLE audio_chunks ADD COLUMN IF NOT EXISTS stt_claimed_at TIMESTAMPTZ;
