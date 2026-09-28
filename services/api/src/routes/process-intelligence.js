// POST /v1/process — Phase 3 thin async kickoff.
import crypto from 'node:crypto';
//
// Ported from functions/index.js `exports.processIntelligence`
// (BUILD-PLAN §3.1: one HTTP surface). Validates the request and the caller's
// own note, then hands the run to queueNoteRun (@algominutes/db kickoff.ts, the
// kickoff every source shares): the budgets, the quota gate, status='queued'
// in Postgres + the Firestore mirror, and the transcoder's Cloud Task. This
// route only maps its result to HTTP. The transcoder owns the fast/chunked
// routing and all heavy work — this handler should finish in <1s of CPU.
//
// Repointed onto the workspace packages:
//   - validateStoragePath        → @algominutes/db storage-paths.cjs
//   - enqueueTask                → @algominutes/ai cloud-tasks.cjs
//   - intelligence helpers       → @algominutes/ai intelligence.cjs
//   - every note status write    → @algominutes/db notes-repo (markQueued /
//     markError): Postgres first, then the Firestore mirror, tenant-scoped.
//
// Firebase `defineString`/`defineSecret` params become plain Cloud Run env
// vars (TRANSCODER_URL, JOBS_SA_EMAIL, TASKS_*), with the source's defaults.
// hydratePgEnv() is dropped: on Cloud Run the PG* / WRITE_POSTGRES vars are set
// directly in the environment that @algominutes/db reads.

import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import storagePathsModule from '@algominutes/ai/storage-paths.cjs';

import { queueNoteRun } from '@algominutes/db';
import { toEntitlementResponse } from './entitlement.js';
import { NoteType } from '@algominutes/contracts/schemas';

const { isValidId } = intelligenceModule;
const { validateStoragePath } = storagePathsModule;

export async function processIntelligenceRoute(req, res) {
  const baseLog = req.log;

  // Auth handled by the shared middleware; identity claims come from it.
  const callerUid = req.uid;
  const callerEmail = req.authEmail;
  const callerName = req.authName;

  // ── Validate body (storagePath OR sourceUrl, not both) ────
  const { noteId, workspaceId, type, storagePath, sourceUrl, mimeType: clientMime } = req.body || {};
  // `type` must be a published NoteType (the documented ProcessRequest contract).
  if (!isValidId(noteId) || !isValidId(workspaceId) || !NoteType.safeParse(type).success) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${callerUid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }
  if (storagePath !== undefined) {
    const v = validateStoragePath(storagePath, workspaceId);
    if (!v.ok) return res.status(400).json({ error: 'Invalid storagePath' });
  }
  if (type === 'youtube') {
    if (typeof sourceUrl !== 'string' || sourceUrl.length > 1024) {
      return res.status(400).json({ error: 'Invalid sourceUrl' });
    }
    let parsedHost = '';
    // silent-catch-ok: an unparseable URL is the client's input error, answered with a 400.
    try { parsedHost = new URL(sourceUrl).host; } catch { return res.status(400).json({ error: 'Invalid sourceUrl' }); }
    const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
    if (!allowedHosts.has(parsedHost)) return res.status(400).json({ error: 'URL host not allowed' });
  }
  if (type !== 'youtube' && !storagePath) {
    return res.status(400).json({ error: 'storagePath required for non-youtube types' });
  }

  const log = baseLog.child({ uid: callerUid, noteId, workspaceId, source: type });
  const db = getFirestore();
  const noteRef = db.doc(`workspaces/${workspaceId}/notes/${noteId}`);

  // ── Idempotency & ownership (cheap; before rate limit) ────
  let noteData = null;
  try {
    const noteSnap = await noteRef.get();
    if (!noteSnap.exists) return res.status(404).json({ error: 'Note not found' });
    noteData = noteSnap.data();
    if (noteData.authorId !== callerUid) return res.status(403).json({ error: 'Not your note' });
    if (noteData.status === 'ready') return res.json({ success: true, noteId, cached: true });
  } catch (err) {
    log.error({ err }, 'ownership_check_failed');
    return res.status(500).json({ error: 'Ownership check failed' });
  }

  // A10 #7 trial anti-abuse: mobile presents a device-attestation token (hashed
  // → trial_device_hash; a device that already trialled gets no fresh trial);
  // web must have an email on the account. (Verifying the token with
  // Apple/Google is TODO(A4-apple)/(A11): the hash is trusted for now.)
  const attToken = String(req.headers['x-device-attestation'] || '');
  const devPlatform = String(req.headers['x-device-platform'] || '') || undefined;
  const deviceHash = attToken ? crypto.createHash('sha256').update(attToken).digest('hex') : undefined;

  const result = await queueNoteRun({
    firestore: db,
    noteId, workspaceId,
    uid: callerUid, email: callerEmail, name: callerName,
    type, storagePath, sourceUrl, mimeType: clientMime,
    // The size drives the bytes budget; storagePath only.
    probeSize: storagePath
      ? async () => {
        const [metadata] = await getStorage().bucket().file(storagePath).getMetadata();
        return Number(metadata.size || 0);
      }
      : undefined,
    // The client's estimate at ingest (the transcoder's ffprobe measures it later).
    durationSec: Number(req.body?.durationSec ?? req.body?.duration ?? noteData?.duration ?? noteData?.durationSec ?? 0),
    trial: { deviceHash, platform: devPlatform, emailPresent: !!req.authEmail },
    traceId: req.traceId,
    log,
  });

  switch (result.kind) {
    case 'queued':
      return res.json({ success: true, noteId, jobId: result.jobId, status: 'queued' });
    case 'in_flight':
      return res.status(202).json({ success: true, noteId, status: result.status, inFlight: true });
    case 'not_found':
      return res.status(404).json({ error: 'Note not found' });
    case 'recording':
      // A notetaker note is still in its meeting: its own ingest queues it.
      return res.status(409).json({ error: 'This note is still recording.' });
    case 'audio_missing':
      return res.status(404).json({ error: 'Audio not found' });
    case 'too_large':
      return res.status(413).json({ error: result.message });
    case 'rate_limited':
      return res.status(429).json({ error: result.message });
    case 'quota_exceeded':
      return res.status(402).json({
        error: 'quota_exceeded',
        message: "You've reached your plan's limit. Upgrade to keep recording.",
        entitlement: result.entitlement ? toEntitlementResponse(result.entitlement) : null,
      });
    case 'account_deleted':
      return res.status(401).json({ error: 'account_deleted' });
    case 'misconfigured':
      return res.status(503).json({ error: result.message });
    case 'failed':
    default:
      return res.status(500).json({ error: result.message || "We couldn't queue your audio. Please try again." });
  }
}
