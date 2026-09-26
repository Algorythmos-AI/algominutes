-- 015: tag a storage purge with the account it belongs to. Expand-only (a new
-- nullable column and an index).

-- ── Why ──────────────────────────────────────────────────────────────────────
-- Account deletion (POST /v1/account/delete) deletes the user's Postgres rows
-- first, in one transaction that also queues a storage_purges row per note.
-- If a later step fails (a purge, a Firestore delete, the Auth delete), the
-- client retries. By then the user's notes and workspaces are gone from
-- Postgres, so the retry finds what's left to purge by uid.
ALTER TABLE storage_purges ADD COLUMN IF NOT EXISTS uid TEXT;

CREATE INDEX IF NOT EXISTS storage_purges_uid_idx ON storage_purges (uid) WHERE uid IS NOT NULL;
