'use strict';

/**
 * Terminal failure state for a note — written to BOTH stores.
 *
 * This existed only in the summarizer. The transcoder caught, logged and
 * returned 500, and its `mirrorError` writes Firestore alone — so after a
 * permanent failure Firestore said `error` while Postgres stayed `transcribing`
 * forever. `/api/note`, which the iOS app reads, serves the Postgres status, so
 * the two clients disagreed about whether a recording had failed and the
 * note showed a spinner that would never resolve. There is no server-side
 * sweeper, and the client watchdog only ticks while the app is foregrounded.
 *
 * Both stores are injected because each service builds its own pool and
 * Firestore handle; the point of sharing this is one copy of the SQL, the
 * status guard, and the never-throw discipline.
 */

/**
 * Cloud Tasks reports the attempt in `X-CloudTasks-TaskRetryCount`, 0-based.
 * The queues are created with `max_attempts = var.task_max_attempts` (Terraform,
 * infra/terraform/modules/environment/main.tf), and every service is deployed
 * with `MAX_TASK_ATTEMPTS` set to that SAME value — so the terminal-failure /
 * DLQ write fires on the queue's genuine last attempt, not before (which would
 * turn a transient blip into a permanent failure) and not after (wasted retries
 * against an already-errored note). Default 5 if the env is unset.
 */
function isFinalAttempt(headers, maxAttempts = Number(process.env.MAX_TASK_ATTEMPTS) || 5) {
  const raw = headers && headers['x-cloudtasks-taskretrycount'];
  const attempt = Number(raw || 0);
  if (!Number.isFinite(attempt)) return false;
  return attempt >= maxAttempts - 1;
}

/**
 * Best-effort, and never throws: this runs on the failure path, and a failure
 * to record the failure must not mask the original error.
 *
 * The `status <> 'ready'` guard matters — a late-arriving failure from a
 * retried task must not walk back a note that has since succeeded.
 */
async function markNoteFailed({ pool, firestore, noteId, workspaceId, message, log, event }) {
  const name = event || 'note_marked_failed';
  if (!noteId || !workspaceId) {
    log.error({ noteId, workspaceId }, `${name}_missing_ids`);
    return;
  }

  let pgOk = false;
  let pgErrored = false;
  try {
    const client = await pool.connect();
    try {
      const { rowCount } = await client.query(
        // Scoped to the payload's workspace (CLAUDE.md §1 multi-tenancy): a
        // note id from another workspace matches nothing.
        `UPDATE notes SET status = 'error', error_message = $2, updated_at = NOW()
          WHERE id = $1 AND workspace_id = $3 AND status <> 'ready'`,
        [noteId, message, workspaceId],
      );
      pgOk = rowCount > 0;
    } finally {
      client.release();
    }
  } catch (err) {
    pgErrored = true;
    log.error({ err, noteId, workspaceId }, `${name}_pg_failed`);
  }

  // Mirror to Firestore only if Postgres agrees the note is now failed, or if
  // the Postgres write itself errored (the user must still see the failure).
  // When the UPDATE succeeded but matched no row, the note is already 'ready'
  // or belongs to another workspace — writing 'error' here would contradict
  // the system of record or create a phantom doc under the wrong workspace.
  const shouldMirror = pgOk || pgErrored;
  let mirrorOk = false;
  if (shouldMirror) {
    try {
      await firestore.doc(`workspaces/${workspaceId}/notes/${noteId}`).set(
        { status: 'error', errorMessage: message, updatedAt: new Date().toISOString() },
        { merge: true },
      );
      mirrorOk = true;
    } catch (err) {
      log.error({ err, noteId, workspaceId }, `${name}_mirror_failed`);
    }
  }

  // One line per terminal failure, with a stable event name, because this is
  // what the alerting in the runbook counts. Emitted whether or not the writes
  // landed — a note that failed and could not even be marked failed is the
  // worst case, not one to stay quiet about.
  log.error({ noteId, workspaceId, pgOk, pgErrored, mirrored: shouldMirror, mirrorOk, reason: message }, 'note_failed');
}

module.exports = { markNoteFailed, isFinalAttempt };
