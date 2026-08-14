// AlgoMinutes Firebase Functions — TRIGGERS ONLY.
//
// Every HTTP endpoint was consolidated into services/api (BUILD-PLAN §3.1). The
// only handler that must remain a Firebase Function is the Firestore trigger
// below: it is event-bound and cannot be an HTTP route.

const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const { getStorage } = require("firebase-admin/storage");
const { initializeApp, getApps } = require("firebase-admin/app");

const { logger: rootLogger } = require("@algominutes/ai/logger.cjs");
const { pool: pgPool } = require("@algominutes/ai/pg-query.cjs");

if (!getApps().length) initializeApp();

const CLOUD_SQL_PASSWORD = defineSecret("CLOUD_SQL_PASSWORD");
const VPC_CONNECTOR = defineString("VPC_CONNECTOR");

// onNoteDeleted — GDPR / App Store compliance cascade.
//
// When a note doc is deleted (by user action, the delete-account endpoint in
// services/api, or admin tooling), best-effort delete the Cloud Storage
// artifacts (audio + scan images) and the Postgres rows downstream.
//
// Postgres ON DELETE CASCADE handles transcript_lines, embeddings, summaries,
// action_items, key_decisions, audio_chunks — so one DELETE FROM notes cleans
// the relational graph. Storage cleanup is best-effort with explicit logging; a
// missing object is fine, an unexpected error is logged but never thrown — the
// trigger must not block a user deletion on a storage transient.
exports.onNoteDeleted = onDocumentDeleted(
  {
    // The clients write notes at workspaces/{wsId}/notes/{noteId}, so the trigger
    // must match that path — not root notes/{noteId} — or it never fires and the
    // GCS + Postgres cascade is silently skipped.
    document: "workspaces/{wsId}/notes/{noteId}",
    region: "us-central1",
    secrets: [CLOUD_SQL_PASSWORD],
    vpcConnector: VPC_CONNECTOR,
    vpcConnectorEgressSettings: "PRIVATE_RANGES_ONLY",
  },
  async (event) => {
    const { randomUUID } = require("node:crypto");
    const traceId = randomUUID();
    const noteId = event.params.noteId;
    // Prefer the wildcard from the path — authoritative even if the doc data is
    // malformed or missing the workspaceId field.
    const workspaceId = event.params.wsId || (event.data?.data() || {}).workspaceId || null;
    const before = event.data?.data() || {};
    const log = rootLogger.child({ traceId, fn: "onNoteDeleted", noteId, workspaceId });

    log.info(
      { before: { storagePath: before.storagePath, sourceType: before.sourceType, status: before.status } },
      "note_delete_cascade_starting",
    );

    // 1) Storage cleanup — best-effort, never throw. Bucket comes from env
    //    (STORAGE_BUCKET), set per environment at provisioning (A4).
    const bucketName = process.env.STORAGE_BUCKET;
    if (!bucketName) {
      log.warn({}, "note_delete_cascade_no_bucket_env"); // skip storage, still run pg cascade
    }
    const candidates = [];
    if (before.storagePath && typeof before.storagePath === "string") {
      candidates.push(before.storagePath);
    }
    // The chunked pipeline's intermediate FLAC files — raw recording audio, keyed
    // by noteId alone rather than by workspace, so this sits outside the
    // workspaceId guard. The transcoder removes these itself once all chunks are
    // transcribed; this stays as the backstop for a note deleted mid-processing.
    const prefixes = [`transcoder/${noteId}/`];
    if (workspaceId) {
      prefixes.push(
        `recordings/${workspaceId}/${noteId}`,
        `imports/${workspaceId}/${noteId}`,
        `scans/${workspaceId}/${noteId}`,
      );
    }
    let storageDeleted = 0;
    let storageMissing = 0;
    let storageFailed = 0;
    if (bucketName) {
      const bucket = getStorage().bucket(bucketName);
      for (const prefix of prefixes) {
        try {
          const [files] = await bucket.getFiles({ prefix });
          for (const f of files) candidates.push(f.name);
        } catch (err) {
          log.warn({ err: { message: err?.message }, prefix }, "note_delete_cascade_list_failed");
        }
      }
      const unique = Array.from(new Set(candidates));
      await Promise.allSettled(
        unique.map(async (objectPath) => {
          try {
            await bucket.file(objectPath).delete({ ignoreNotFound: true });
            storageDeleted++;
          } catch (err) {
            if (err?.code === 404) storageMissing++;
            else {
              storageFailed++;
              log.warn(
                { err: { message: err?.message, code: err?.code }, objectPath },
                "note_delete_cascade_storage_partial",
              );
            }
          }
        }),
      );
    }

    // 2) Postgres cascade — DELETE FROM notes is enough; FK ON DELETE CASCADE
    //    handles transcript_lines / embeddings / summaries / etc.
    let pgDeleted = 0;
    try {
      const { rowCount } = await pgPool().query(
        `DELETE FROM notes WHERE id = $1 AND workspace_id = COALESCE($2, workspace_id)`,
        [noteId, workspaceId],
      );
      pgDeleted = rowCount || 0;
    } catch (err) {
      log.error({ err: { message: err?.message } }, "note_delete_cascade_pg_failed");
      // Don't throw — Firestore doc is already gone; retrying won't help.
    }

    log.info(
      {
        storage: { deleted: storageDeleted, missing: storageMissing, failed: storageFailed, candidates: candidates.length },
        postgres: { deleted: pgDeleted },
      },
      "note_delete_cascade_complete",
    );
  },
);
