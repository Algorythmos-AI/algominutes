// POST /v1/process — Phase 3 thin async kickoff.
//
// Ported from functions/index.js `exports.processIntelligence`
// (BUILD-PLAN §3.1: one HTTP surface). Validates the request, persists
// status='queued' in Postgres + a Firestore mirror, and enqueues a Cloud Task
// to the transcoder. The transcoder owns the fast/chunked routing and all heavy
// work — this handler should finish in <1s of CPU.
//
// Repointed onto the workspace packages:
//   - the local pg-pool factory  → @algominutes/db pg-query.cjs `pool()`
//   - validateStoragePath        → @algominutes/db storage-paths.cjs
//   - enqueueTask                → @algominutes/ai cloud-tasks.cjs
//   - intelligence helpers       → @algominutes/ai intelligence.cjs
//   The queued-upsert SQL has no repo function, so it stays here but runs on the
//   SHARED pool (not a re-created local one). Behaviour is preserved exactly.
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
import pgQueryModule from '@algominutes/ai/pg-query.cjs';

// A9.2 metered-minutes gate — assert quota and charge the ledger BEFORE any paid
// transcode work is queued. resolveEntitlement/assertCanMeter/meterMinutes all
// live in the @algominutes/db repo layer (never trust the client for quota).
import { assertCanMeter, meterMinutes, QuotaExceededError } from '@algominutes/db';
import { toEntitlementResponse } from './entitlement.js';

const { MAX_AUDIO_BYTES, isValidId, publicErrorFor, enforceUsageBudget } = intelligenceModule;
const { validateStoragePath } = storagePathsModule;
const { enqueueTask } = cloudTasksModule;
const { pool, postgresEnabled } = pgQueryModule;

// Lazy-sync the user, workspace, and workspace membership rows before
// inserting the note. Without this, any Firebase user not previously
// backfilled hits an FK violation on notes_workspace_id_fkey or
// notes_author_uid_fkey, the kickoff swallows the error (defensive), and the
// transcoder's downstream writes fail silently.
//
// Idempotent: ON CONFLICT DO NOTHING on every parent insert. Wrapped in a
// single transaction so a partial failure rolls back cleanly. Runs on the
// SHARED @algominutes/db pool.
async function upsertNoteQueued({
  noteId, workspaceId, callerUid, callerEmail, callerName,
  sourceType, storagePath, sourceUrl, mimeType, log,
}) {
  if (!postgresEnabled()) return;
  const client = await pool().connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO users (uid, email, display_name)
         VALUES ($1, $2, $3)
       ON CONFLICT (uid) DO UPDATE SET
         email        = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
      [callerUid, callerEmail || null, callerName || null],
    );

    await client.query(
      `INSERT INTO workspaces (id, owner_uid, name)
         VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [workspaceId, callerUid, callerName ? `${callerName}'s Workspace` : 'My Workspace'],
    );

    await client.query(
      `INSERT INTO workspace_members (workspace_id, uid, role)
         VALUES ($1, $2, 'owner')
       ON CONFLICT (workspace_id, uid) DO NOTHING`,
      [workspaceId, callerUid],
    );

    await client.query(
      `INSERT INTO notes (id, workspace_id, author_uid, status, source_type, storage_path, source_url, mime_type)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         status = 'queued',
         source_type = EXCLUDED.source_type,
         storage_path = COALESCE(EXCLUDED.storage_path, notes.storage_path),
         source_url   = COALESCE(EXCLUDED.source_url, notes.source_url),
         mime_type    = COALESCE(EXCLUDED.mime_type, notes.mime_type),
         summarizer_enqueued_at = NULL,
         embedder_enqueued_at = NULL,
         chunks_done = 0,
         chunks_total = NULL,
         duration_sec_probed = NULL,
         error_message = NULL,
         updated_at = NOW()`,
      [noteId, workspaceId, callerUid, sourceType, storagePath || null, sourceUrl || null, mimeType || null],
    );

    // A retry is a fresh start, so the previous run's chunk rows have to go.
    // Safe because it runs in the same transaction that sets status='queued',
    // before any chunk work for this run begins.
    await client.query(`DELETE FROM audio_chunks WHERE note_id = $1`, [noteId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => {
      // Log the rollback failure separately so it doesn't mask the
      // original cause when both surface in the same flow.
      log.child({ noteId, workspaceId }).error({ rollbackErr }, 'upsert_note_queued_rollback_failed');
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function processIntelligenceRoute(req, res) {
  const baseLog = req.log;
  const traceId = req.traceId;

  // Auth handled by the shared middleware; identity claims come from it.
  const callerUid = req.uid;
  const callerEmail = req.authEmail;
  const callerName = req.authName;

  // ── Validate body (storagePath OR sourceUrl, not both) ────
  const { noteId, workspaceId, type, storagePath, sourceUrl, mimeType: clientMime } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId) || !type) {
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
      await noteRef
        .set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
        .catch((mirrorErr) => log.error({ err: mirrorErr }, 'firestore_write_failed:too_large_mirror'));
      return res.status(413).json({ error: userMsg });
    }
  }

  // ── Usage budget (count + bytes, atomic) ──────────────────
  try {
    await enforceUsageBudget(db, callerUid, probedSize);
  } catch (err) {
    const userMsg = publicErrorFor(err);
    await noteRef
      .set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((mirrorErr) => log.error({ err: mirrorErr }, 'firestore_write_failed:rate_limit_mirror'));
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
    await assertCanMeter(callerUid, minutes);
    // Idempotent under Cloud Tasks / client retry: the UNIQUE idempotency_key
    // makes a replay a no-op, so we never double-charge a note's ingest.
    await meterMinutes({
      uid: callerUid,
      workspaceId,
      noteId,
      minutes,
      reason: 'ingest',
      idempotencyKey: `${noteId}:ingest`,
    });
  } catch (err) {
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

  // ── Persist queued state in PG + Firestore mirror ─────────
  try {
    await upsertNoteQueued({
      noteId, workspaceId, callerUid, callerEmail, callerName,
      sourceType: type, storagePath, sourceUrl, mimeType: clientMime, log,
    });
  } catch (err) {
    log.error({ err }, 'pg_upsert_queued_failed');
    const userMsg = "We couldn't queue your audio. Please try again.";
    await noteRef.set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((mirrorErr) => log.error({ err: mirrorErr }, 'firestore_write_failed:pg_queue'));
    return res.status(500).json({ error: userMsg });
  }
  await noteRef.set({
    status: 'queued',
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  // ── Enqueue Cloud Task ────────────────────────────────────
  // Firebase defineString params → Cloud Run env vars (same defaults).
  const transcoderUrl = process.env.TRANSCODER_URL || '';
  const jobsSa = process.env.JOBS_SA_EMAIL || '';
  const tasksProject = process.env.TASKS_PROJECT || '';
  const tasksLocation = process.env.TASKS_LOCATION || 'us-central1';
  const tasksQueue = process.env.TASKS_QUEUE || 'audio-jobs';
  if (!transcoderUrl || !jobsSa || !tasksProject) {
    log.error({ transcoderUrl: !!transcoderUrl, jobsSa: !!jobsSa, tasksProject: !!tasksProject }, 'kickoff_misconfigured');
    const userMsg = 'Service is being upgraded. Please try again shortly.';
    await noteRef.set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((mirrorErr) => log.error({ err: mirrorErr }, 'firestore_write_failed:kickoff_misconfig'));
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
      },
      log,
    });
  } catch (err) {
    log.error({ err }, 'task_enqueue_failed');
    const userMsg = "We couldn't queue your audio. Please try again.";
    await noteRef.set({ status: 'error', errorMessage: userMsg, updatedAt: new Date().toISOString() }, { merge: true })
      .catch((mirrorErr) => log.error({ err: mirrorErr }, 'firestore_write_failed:enqueue'));
    return res.status(500).json({ error: userMsg });
  }

  await db
    .collection('analytics')
    .add({ event: 'process_queued', noteId, noteType: type, workspaceId, traceId, jobId, timestamp: new Date().toISOString() })
    .catch((err) => log.error({ err }, 'analytics_write_failed:queued'));

  log.info({ jobId }, 'kickoff_enqueued');
  return res.json({ success: true, noteId, jobId, status: 'queued' });
}
