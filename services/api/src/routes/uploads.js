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
import { CreateUploadSessionRequest } from '@algominutes/contracts/schemas';

const { isValidId } = intelligenceModule;
const { validateStoragePath } = storagePathsModule;

// GCS requires resumable chunk lengths to be multiples of 256 KiB; 8 MiB is a
// clean multiple and a good balance of round-trips vs. retry cost on mobile.
const CHUNK_SIZE = 8 * 1024 * 1024;

// A GCS resumable session URI is valid for one week from creation. We surface
// that so a client can decide whether to resume or start a fresh session.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The uploadId is a self-describing, opaque handle: base64url(JSON) carrying the
// session URI, storage path, and total size, so the status/complete handlers are
// stateless (no upload-sessions table). It is opaque to clients — they treat it
// as a token and PUT their chunks to `sessionUri`, not to uploadId.
// TODO(A11): if audit requires server-visible upload state, persist these in a
// repo table instead of encoding them in the handle.
function encodeUploadId(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeUploadId(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // A malformed handle is a client bug (a truncated/garbled token), not a
    // server error — decode failure maps to a 400 at the call site.
    return null;
  }
  if (!decoded || typeof decoded.sessionUri !== 'string' || typeof decoded.storagePath !== 'string') {
    return null;
  }
  return decoded;
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

  const uploadId = encodeUploadId({ sessionUri, storagePath, totalBytes });
  log.info({ storagePath, totalBytes }, 'upload_session_created');
  return res.json({
    uploadId,
    sessionUri,
    storagePath,
    chunkSize: CHUNK_SIZE,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
}

export async function getUploadStatusRoute(req, res) {
  const session = decodeUploadId(req.params.uploadId);
  if (!session) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }
  const { sessionUri, totalBytes } = session;
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
    req.log.error({ err }, 'upload_status_probe_failed');
    return res.status(502).json({ error: "We couldn't check your upload. Please try again." });
  }

  if (resp.status === 200 || resp.status === 201) {
    return res.json({ uploadId: req.params.uploadId, receivedBytes: Number.isFinite(total) ? total : 0, complete: true });
  }
  // 308 Resume Incomplete — parse the acknowledged byte range.
  let receivedBytes = 0;
  const range = resp.headers.get('range');
  if (range) {
    const m = /bytes=0-(\d+)/.exec(range);
    if (m) receivedBytes = Number(m[1]) + 1; // Range is inclusive of the last byte.
  }
  return res.json({ uploadId: req.params.uploadId, receivedBytes, complete: false });
}

export async function completeUploadRoute(req, res) {
  const session = decodeUploadId(req.params.uploadId);
  if (!session) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }
  const { storagePath } = session;

  // The bytes were PUT directly to GCS by the client; there is no server-side
  // upload state to flip. We confirm the finalized object exists rather than
  // trusting the client's word that the transfer completed.
  // TODO(A11): verify getMetadata against live GCS.
  try {
    const bucket = getStorage().bucket();
    const [exists] = await bucket.file(storagePath).exists();
    if (!exists) {
      req.log.warn({ storagePath }, 'complete_upload_object_missing');
      return res.status(409).json({ error: 'Upload is not complete yet.' });
    }
  } catch (err) {
    req.log.error({ err, storagePath }, 'complete_upload_check_failed');
    return res.status(502).json({ error: "We couldn't finalize your upload. Please try again." });
  }

  req.log.info({ storagePath }, 'upload_completed');
  return res.json({ uploadId: req.params.uploadId, storagePath, complete: true });
}
