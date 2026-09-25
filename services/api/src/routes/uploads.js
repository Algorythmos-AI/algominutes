// Resumable upload session endpoints (A7.2).
//
//   POST /v1/uploads                     — create a GCS resumable upload session
//   GET  /v1/uploads/:uploadId           — report received bytes / completion
//   POST /v1/uploads/:uploadId/complete  — mark the upload complete
//
// The client PUTs chunks directly to the returned `sessionUri` via a background
// transfer (iOS URLSession background; Android WorkManager), persisting the byte
// offset so it resumes after an app kill or reboot. The server only mints the
// session and answers status/complete queries — the bytes never transit here.
//
// TODO(A11): these three handlers cannot be runtime-tested in this environment
// (no GCS credentials). Verify createResumableUpload, the status probe, and the
// finalized-object check against live GCS before shipping.

import { getStorage } from 'firebase-admin/storage';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import storagePathsModule from '@algominutes/ai/storage-paths.cjs';
import noteStorageModule from '@algominutes/ai/note-storage.cjs';
import { CreateUploadSessionRequest } from '@algominutes/contracts/schemas';
import {
  createUploadSession,
  getUploadSession,
  isPostgresEnabled,
  UploadSessionsUnavailableError,
  WorkspaceBoundaryError,
  isAccountDeleted,
} from '@algominutes/db';

const { isValidId } = intelligenceModule;
const { validateStoragePath } = storagePathsModule;

// GCS requires resumable chunk lengths to be multiples of 256 KiB; 8 MiB is a
// clean multiple and a good balance of round-trips vs. retry cost on mobile.
const CHUNK_SIZE = 8 * 1024 * 1024;

// A GCS resumable session URI is valid for one week from creation. We surface
// that so a client can decide whether to resume or start a fresh session.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The uploadId is an opaque random id for a server-side session row
// (@algominutes/db upload-sessions-repo, migration 013). It used to be
// base64 JSON of the session itself, and the server trusted the URI and path
// inside it: an SSRF, plus a cross-workspace "does this object exist" oracle.
// Now nothing a client sends is used as a URL or a path.

// Defense in depth: the session URI is minted by GCS and read from our own
// database, but only a GCS resumable-upload URL is ever contacted.
function isGcsSessionUri(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' && u.hostname === 'storage.googleapis.com';
  } catch {
    // silent-catch-ok: an unparseable URI is simply not a GCS session URI
    return false;
  }
}

// One answer for malformed, unknown, someone else's and expired ids, so a
// guess learns nothing.
function notFound(res) {
  return res.status(404).json({ error: 'Upload not found' });
}

// recordings/{workspaceId}/{noteId}.{ext} — the path convention shared with the
// iOS client (StoragePaths.swift) and enforced by storage.rules.
function extFromFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return '';
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export async function createUploadSessionRoute(req, res) {
  const parsed = CreateUploadSessionRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  const { noteId, workspaceId, fileName, contentType, totalBytes } = parsed.data;

  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  // A workspace is derived from the uid, so a mismatch is a client bug or an
  // attack, never a legitimate cross-workspace upload — same rule as every
  // other authed route.
  if (workspaceId !== `workspace_${req.uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }

  const ext = extFromFileName(fileName);
  const storagePath = ext
    ? `recordings/${workspaceId}/${noteId}.${ext}`
    : `recordings/${workspaceId}/${noteId}`;
  const v = validateStoragePath(storagePath, workspaceId);
  if (!v.ok) {
    return res.status(400).json({ error: 'Invalid storagePath' });
  }

  const log = req.log.child({ noteId, workspaceId });
  // Before asking GCS for a session: without Postgres there is nowhere to
  // record it, and a minted-then-dropped session would just be orphaned.
  if (!isPostgresEnabled()) {
    log.error({}, 'upload_sessions_unavailable');
    return res.status(503).json({ error: 'Uploads are unavailable until Postgres is provisioned.' });
  }
  // A deleted account's token can still verify for up to an hour. Refuse
  // before minting a GCS session, which is a capability to write objects.
  if (await isAccountDeleted(req.uid)) {
    log.warn({}, 'upload_account_deleted');
    return res.status(401).json({ error: 'account_deleted' });
  }
  let sessionUri;
  try {
    const bucket = getStorage().bucket();
    const file = bucket.file(storagePath);
    // createResumableUpload returns [uri]; the client uploads chunks to it.
    // TODO(A11): verify against live GCS.
    [sessionUri] = await file.createResumableUpload({
      metadata: { contentType },
    });
  } catch (err) {
    log.error({ err, storagePath }, 'create_resumable_upload_failed');
    return res.status(502).json({ error: "We couldn't start your upload. Please try again." });
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  let uploadId;
  try {
    uploadId = await createUploadSession({
      uid: req.uid, email: req.authEmail, name: req.authName,
      workspaceId, noteId, storagePath, sessionUri, totalBytes, expiresAt,
    }, log);
  } catch (err) {
    if (err?.code === 'ACCOUNT_DELETED') {
      log.warn({}, 'upload_account_deleted');
      return res.status(401).json({ error: 'account_deleted' });
    }
    if (err?.code === 'NOTE_DELETED') {
      // Deleted while (or before) this request ran. The session we just minted
      // is a capability to write into it: cancel it, then answer as for a note
      // that doesn't exist. A failed cancel is logged; the session expires in a
      // week and no kickoff can use the note.
      await noteStorageModule.cancelResumableUpload(sessionUri)
        .catch((cancelErr) => log.error({ err: cancelErr }, 'upload_deleted_note_cancel_failed'));
      log.warn({}, 'upload_note_deleted');
      return res.status(404).json({ error: 'Note not found' });
    }
    if (err instanceof WorkspaceBoundaryError || err?.code === 'WORKSPACE_BOUNDARY') {
      log.warn({ err }, 'upload_workspace_boundary');
      return res.status(403).json({ error: 'Workspace mismatch' });
    }
    if (err instanceof UploadSessionsUnavailableError) {
      log.error({ err }, 'upload_sessions_unavailable');
      return res.status(503).json({ error: 'Uploads are unavailable until Postgres is provisioned.' });
    }
    log.error({ err, storagePath }, 'upload_session_record_failed');
    return res.status(502).json({ error: "We couldn't start your upload. Please try again." });
  }
  log.info({ storagePath, totalBytes }, 'upload_session_created');
  return res.json({
    uploadId,
    sessionUri,
    storagePath,
    chunkSize: CHUNK_SIZE,
    expiresAt: expiresAt.toISOString(),
  });
}

async function loadSession(req) {
  return getUploadSession({ id: req.params.uploadId, uid: req.uid });
}

export async function getUploadStatusRoute(req, res) {
  let session;
  try {
    session = await loadSession(req);
  } catch (err) {
    req.log.error({ err }, 'upload_session_lookup_failed');
    return res.status(502).json({ error: "We couldn't check your upload. Please try again." });
  }
  if (!session) return notFound(res);
  const log = req.log.child({ noteId: session.noteId, workspaceId: session.workspaceId, uploadId: session.id });
  const { sessionUri, totalBytes } = session;
  if (!isGcsSessionUri(sessionUri)) {
    log.error({}, 'upload_session_uri_not_gcs');
    return res.status(500).json({ error: "We couldn't check your upload. Please try again." });
  }
  const total = Number(totalBytes);

  // GCS resumable protocol: an empty PUT with `Content-Range: bytes */<total>`
  // asks how much the server already has. 308 (Resume Incomplete) carries a
  // `Range: bytes=0-<last>` header; 200/201 means the object is finalized.
  // TODO(A11): verify status semantics against live GCS.
  let resp;
  try {
    resp = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Length': '0',
        'Content-Range': `bytes */${Number.isFinite(total) && total > 0 ? total : '*'}`,
      },
    });
  } catch (err) {
    log.error({ err }, 'upload_status_probe_failed');
    return res.status(502).json({ error: "We couldn't check your upload. Please try again." });
  }

  if (resp.status === 200 || resp.status === 201) {
    return res.json({ uploadId: session.id, receivedBytes: Number.isFinite(total) ? total : 0, complete: true });
  }
  // 308 Resume Incomplete — parse the acknowledged byte range.
  let receivedBytes = 0;
  const range = resp.headers.get('range');
  if (range) {
    const m = /bytes=0-(\d+)/.exec(range);
    if (m) receivedBytes = Number(m[1]) + 1; // Range is inclusive of the last byte.
  }
  return res.json({ uploadId: session.id, receivedBytes, complete: false });
}

export async function completeUploadRoute(req, res) {
  let session;
  try {
    session = await loadSession(req);
  } catch (err) {
    req.log.error({ err }, 'upload_session_lookup_failed');
    return res.status(502).json({ error: "We couldn't finalize your upload. Please try again." });
  }
  if (!session) return notFound(res);
  const log = req.log.child({ noteId: session.noteId, workspaceId: session.workspaceId, uploadId: session.id });
  const { storagePath } = session; // the caller's own path, from our database

  // The bytes were PUT directly to GCS by the client; there is no server-side
  // upload state to flip. We confirm the finalized object exists rather than
  // trusting the client's word that the transfer completed.
  // TODO(A11): verify getMetadata against live GCS.
  try {
    const bucket = getStorage().bucket();
    const [exists] = await bucket.file(storagePath).exists();
    if (!exists) {
      log.warn({ storagePath }, 'complete_upload_object_missing');
      return res.status(409).json({ error: 'Upload is not complete yet.' });
    }
  } catch (err) {
    log.error({ err, storagePath }, 'complete_upload_check_failed');
    return res.status(502).json({ error: "We couldn't finalize your upload. Please try again." });
  }

  log.info({ storagePath }, 'upload_completed');
  return res.json({ uploadId: session.id, storagePath, complete: true });
}
