// POST /v1/process — Phase 3 thin async kickoff.
import crypto from 'node:crypto';
//
// Ported from functions/index.js `exports.processIntelligence`
// (BUILD-PLAN §3.1: one HTTP surface). Validates the request, persists
// status='queued' in Postgres + a Firestore mirror, and enqueues a Cloud Task
// to the transcoder. The transcoder owns the fast/chunked routing and all heavy
// work — this handler should finish in <1s of CPU.
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
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';

// A9.2 metered-minutes gate — assert quota and charge the ledger BEFORE any paid
// transcode work is queued. assertCanMeter and the debit (written by
// markQueued) live in the @algominutes/db repo layer (never trust the client
// for quota).
import {
  assertCanMeter,
  QuotaExceededError,
  ensureTrial,
  markQueued,
  markError,
  markKickoffRejected,
  getNoteQueueState,
  WorkspaceBoundaryError,
} from '@algominutes/db';
import { toEntitlementResponse } from './entitlement.js';
import { NoteType } from '@algominutes/contracts/schemas';

const { MAX_AUDIO_BYTES, isValidId, publicErrorFor, enforceUsageBudget } = intelligenceModule;
const { validateStoragePath } = storagePathsModule;
const { enqueueTask } = cloudTasksModule;
// Mark the note failed through the repo layer (Postgres scoped to the caller's
// workspace, then the Firestore mirror). Never throws: the caller is already on
// an error path, and a failure to record the failure is itself logged.
// Refunded in the failure's transaction: past markQueued the run was already
// charged, and it never started (net-guarded, so a note never charged gets
// nothing back).
async function failNote(db, { noteId, workspaceId, userMsg, log, event }) {
  const refund = { reason: 'refund:enqueue_failed', idempotencyKey: `${noteId}:refund:enqueue` };
  await markError(db, { noteId, workspaceId, errorMessage: userMsg, refund }, log).catch((err) =>
    log.error({ err, event }, 'mark_error_failed'),
  );
}
// A refusal before markQueued (too large, rate limit): as failNote, but a note
// a concurrent duplicate kickoff already queued is left running.
async function rejectNote(db, { noteId, workspaceId, userMsg, log, event }) {
  try {
    const { marked } = await markKickoffRejected(db, { noteId, workspaceId, errorMessage: userMsg }, log);
    if (!marked) log.info({ event }, 'kickoff_rejection_spared_in_flight_note');
  } catch (err) {
    log.error({ err, event }, 'mark_error_failed');
  }
}

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

  // ── Postgres pre-check: foreign or already in flight? ─────
  // Before the size probe, rate limit and metering, so a duplicate kickoff (a
  // client retry after a timeout) or a foreign note id costs nothing and
  // changes nothing. markQueued repeats this check atomically.
  let queueState;
  try {
    queueState = await getNoteQueueState({ noteId, workspaceId });
  } catch (err) {
    log.error({ err }, 'note_queue_state_failed');
    return res.status(500).json({ error: "We couldn't queue your audio. Please try again." });
  }
  if (queueState.foreign) {
    log.warn({}, 'process_note_workspace_boundary');
    return res.status(404).json({ error: 'Note not found' });
  }
  if (queueState.inFlight) {
    log.info({ status: queueState.status }, 'process_already_in_flight');
    return res.status(202).json({ success: true, noteId, status: queueState.status, inFlight: true });
  }

  // ── Probe audio size (drives bytes budget; storagePath only) ─
  let probedSize = 0;
  if (storagePath) {
    try {
      const bucket = getStorage().bucket();
      const file = bucket.file(storagePath);
      const [metadata] = await file.getMetadata();
      probedSize = Number(metadata.size || 0);
    } catch (err) {
      log.error({ err, storagePath }, 'storage_metadata_failed');
      return res.status(404).json({ error: 'Audio not found' });
    }
    if (probedSize > MAX_AUDIO_BYTES) {
      const userMsg = publicErrorFor(new Error('TOO_LARGE'));
      await rejectNote(db, { noteId, workspaceId, userMsg, log, event: 'too_large' });
      return res.status(413).json({ error: userMsg });
    }
  }

  // ── Usage budget (count + bytes, atomic) ──────────────────
  try {
    await enforceUsageBudget(db, callerUid, probedSize);
  } catch (err) {
    const userMsg = publicErrorFor(err);
    await rejectNote(db, { noteId, workspaceId, userMsg, log, event: 'rate_limit' });
    log.warn({ reason: err.message, bytes: probedSize }, 'usage_budget_exceeded');
    return res.status(429).json({ error: userMsg });
  }

  // ── A9.2 metered-minutes quota gate ───────────────────────
  // Enforced SERVER-SIDE before any paid transcode work is queued: rejecting
  // over-quota work AFTER paying Google for STT is the expensive mistake. The
  // duration is the client's estimate at ingest (the transcoder's ffprobe is
  // the authoritative measure later); billing rounds partial minutes up.
  const durationSecEstimate = Number(
    req.body?.durationSec ?? req.body?.duration ?? noteData?.duration ?? noteData?.durationSec ?? 0,
  );
  const minutes = Number.isFinite(durationSecEstimate) && durationSecEstimate > 0
    ? Math.ceil(durationSecEstimate / 60)
    : 0;
  try {
    // A9.3 reverse trial auto-starts at first value (first metered action), not at
    // install — idempotent, so a same-uid reinstall never restarts the 7 days.
    // A10 #7 anti-abuse: mobile must present a device-attestation token (hashed →
    // trial_device_hash; a device that already trialed gets no fresh trial); web
    // must have an email on the account. Failing the gate opens on the free floor,
    // not a new 7 days. (Verifying the attestation token's authenticity with
    // Apple/Google is TODO(A4-apple)/(A11) — the hash is trusted for now.)
    const attToken = String(req.headers['x-device-attestation'] || '');
    const devPlatform = String(req.headers['x-device-platform'] || '') || undefined;
    const deviceHash = attToken
      ? crypto.createHash('sha256').update(attToken).digest('hex')
      : undefined;
    await ensureTrial(callerUid, {
      deviceHash,
      platform: devPlatform,
      emailPresent: !!req.authEmail,
      user: { email: callerEmail, name: callerName },
      log,
    });
    await assertCanMeter(callerUid, minutes);
    // The debit itself is written by markQueued, in the transaction that
    // creates the note row (usage_ledger.note_id is a foreign key), and only
    // if it actually queues. Idempotent by key: a retry never charges twice.
  } catch (err) {
    if (err?.code === 'ACCOUNT_DELETED') {
      log.warn({}, 'process_account_deleted');
      return res.status(401).json({ error: 'account_deleted' });
    }
    // instanceof is the intent; the code check is the cross-realm fallback
    // (a QuotaExceededError thrown from another module copy still matches).
    if (err instanceof QuotaExceededError || err?.code === 'QUOTA_EXCEEDED') {
      log.warn({ minutes, plan: err.entitlement?.plan }, 'quota_exceeded');
      return res.status(402).json({
        error: 'quota_exceeded',
        message: "You've reached your plan's limit. Upgrade to keep recording.",
        entitlement: err.entitlement ? toEntitlementResponse(err.entitlement) : null,
      });
    }
    log.error({ err }, 'meter_ingest_failed');
    return res.status(500).json({ error: "We couldn't queue your audio. Please try again." });
  }

  // ── Persist queued state: Postgres, then the Firestore mirror ──
  let queued;
  try {
    queued = await markQueued(db, {
      noteId, workspaceId,
      authorUid: callerUid, authorEmail: callerEmail, authorName: callerName,
      sourceType: type, storagePath, sourceUrl, mimeType: clientMime,
      meter: { minutes, idempotencyKey: `${noteId}:ingest` },
    }, log);
  } catch (err) {
    if (err?.code === 'ACCOUNT_DELETED') {
      // The account was deleted; its token is still valid for up to an hour.
      log.warn({}, 'process_account_deleted');
      return res.status(401).json({ error: 'account_deleted' });
    }
    if (err instanceof WorkspaceBoundaryError || err?.code === 'WORKSPACE_BOUNDARY') {
      // Postgres note ids are global: this id belongs to another workspace.
      // Nothing was written; answer exactly as for a note that doesn't exist.
      log.warn({ err }, 'process_note_workspace_boundary');
      return res.status(404).json({ error: 'Note not found' });
    }
    log.error({ err }, 'mark_queued_failed');
    const userMsg = "We couldn't queue your audio. Please try again.";
    await failNote(db, { noteId, workspaceId, userMsg, log, event: 'queue' });
    return res.status(500).json({ error: userMsg });
  }
  if (queued.deleted) {
    // Deleted while this request ran: it stays deleted, and nothing is queued.
    log.info({}, 'process_note_deleted');
    return res.status(404).json({ error: 'Note not found' });
  }
  if (!queued.queued) {
    // Lost the race to a concurrent duplicate that queued first: that run owns
    // the note. Don't enqueue a second kickoff.
    log.info({ status: queued.status }, 'process_already_in_flight');
    return res.status(202).json({ success: true, noteId, status: queued.status, inFlight: true });
  }

  // ── Enqueue Cloud Task ────────────────────────────────────
  // Firebase defineString params → Cloud Run env vars (same defaults).
  const transcoderUrl = process.env.TRANSCODER_URL || '';
  const jobsSa = process.env.JOBS_SA_EMAIL || '';
  const tasksProject = process.env.TASKS_PROJECT || '';
  const tasksLocation = process.env.TASKS_LOCATION || 'us-central1';
  // The kickoff targets the transcoder, so it goes on the transcode queue
  // (Terraform-created name); TASKS_QUEUE kept as a legacy override.
  const tasksQueue = process.env.TRANSCODE_QUEUE || process.env.TASKS_QUEUE || 'transcode';
  if (!transcoderUrl || !jobsSa || !tasksProject) {
    log.error({ transcoderUrl: !!transcoderUrl, jobsSa: !!jobsSa, tasksProject: !!tasksProject }, 'kickoff_misconfigured');
    const userMsg = 'Service is being upgraded. Please try again shortly.';
    await failNote(db, { noteId, workspaceId, userMsg, log, event: 'kickoff_misconfig' });
    return res.status(503).json({ error: userMsg });
  }

  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await enqueueTask({
      projectId: tasksProject,
      location: tasksLocation,
      queue: tasksQueue,
      targetUrl: transcoderUrl,
      oidcServiceAccount: jobsSa,
      payload: {
        kind: 'kickoff',
        jobId,
        noteId,
        workspaceId,
        type,
        storagePath,
        sourceUrl,
        mimeType: clientMime,
        // The caller, carried through every worker hop so their logs name the
        // user (CLAUDE.md §1: userId where it exists).
        uid: callerUid,
      },
      traceId: req.traceId,
      log,
    });
  } catch (err) {
    log.error({ err }, 'task_enqueue_failed');
    const userMsg = "We couldn't queue your audio. Please try again.";
    await failNote(db, { noteId, workspaceId, userMsg, log, event: 'enqueue' });
    return res.status(500).json({ error: userMsg });
  }

  // The kickoff's record: this line carries traceId, userId, noteId,
  // workspaceId, the note type (`source`) and the jobId, and a log-based
  // metric counts it. (It used to be duplicated into a root Firestore
  // `analytics` doc, which nothing read and account deletion had to sweep.)
  log.info({ jobId }, 'kickoff_enqueued');
  return res.json({ success: true, noteId, jobId, status: 'queued' });
}
