-- RELEASE.md PR 33 (R3): an upload session may be minted before its length is known. The web recorder (and
-- the extension) upload while recording, into a resumable session of unknown length, and the size cap is
-- checked at /complete instead.
-- contract: relaxes upload_sessions.total_bytes to NULLable. Every image writes it today, and the only
-- reader (the api's status probe, services/api/src/routes/uploads.js) already asks GCS with "bytes */*"
-- when the total isn't a positive number; the CHECK (total_bytes >= 0) passes NULL. So old and new images
-- both serve against it, and a rollback leaves nothing stranded.
ALTER TABLE upload_sessions ALTER COLUMN total_bytes DROP NOT NULL;
