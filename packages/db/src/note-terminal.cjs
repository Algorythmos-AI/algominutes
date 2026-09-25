'use strict';

/**
 * Terminal failure state for a note — written to BOTH stores.
 *
 * This existed only in the summarizer. The transcoder caught, logged and
 * returned 500, and its `mirrorError` (since removed) wrote Firestore alone, so
 * after a permanent failure Firestore said `error` while Postgres stayed
 * `transcribing`, and the clients disagreed about whether a recording had
 * failed. The stuck-note sweep (db-job, after 3.5 h) is the backstop, not the
 * first line.
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
 * Except with `retryOnPgError`, for a failure the handler decided on itself (an
 * unreadable file, a speech job that errored, no words) and would otherwise
 * acknowledge. There a Postgres error throws before anything is mirrored, so
 * the task is retried and decides again, instead of acking a note Postgres
 * still has in progress. The queue's last attempt ends in the index.js
 * terminal path, which calls this without the flag.
 *
 * The `status <> 'ready'` guard matters — a late-arriving failure from a
 * retried task must not walk back a note that has since succeeded.
 * `onlyIfStatus` narrows it to those statuses (the spend cap fails only a
 * note no paid work has started on).
 *
 * Returns `{ failed }`: whether Postgres moved the note to 'error' here, so a
 * caller runs its refund and notify hooks on that transition only.
 */
async function markNoteFailed({ pool, firestore, noteId, workspaceId, message, log, event, retryOnPgError = false, onlyIfStatus = null }) {
  const name = event || 'note_marked_failed';
  if (!noteId || !workspaceId) {
    log.error({ noteId, workspaceId }, `${name}_missing_ids`);
    return { failed: false };
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
          WHERE id = $1 AND workspace_id = $3 AND status <> 'ready'
            AND ($4::text[] IS NULL OR status = ANY($4::text[]))`,
        [noteId, message, workspaceId, onlyIfStatus],
      );
      pgOk = rowCount > 0;
    } finally {
      client.release();
    }
  } catch (err) {
    pgErrored = true;
    log.error({ err, noteId, workspaceId }, `${name}_pg_failed`);
    if (retryOnPgError) throw err;
  }

  // Mirror to Firestore only if Postgres agrees the note is now failed, or if
  // the Postgres write itself errored (the user must still see the failure).
  // When the UPDATE succeeded but matched no row, the note is already 'ready'
  // or belongs to another workspace — writing 'error' here would contradict
  // the system of record or create a phantom doc under the wrong workspace.
  // (Not with `onlyIfStatus`: Postgres couldn't say whether the note was one
  // to fail, so mirroring 'error' could contradict it.)
  const shouldMirror = pgOk || (pgErrored && !onlyIfStatus);
  let mirrorOk = false;
  if (shouldMirror) {
    try {
      // update(), never set(): if the Postgres write errored because the note
      // was just deleted, set({ merge: true }) would re-create its doc as a
      // phantom 'error' note. update() fails on a missing doc instead.
      await firestore.doc(`workspaces/${workspaceId}/notes/${noteId}`).update(
        { status: 'error', errorMessage: message, updatedAt: new Date().toISOString() },
      );
      mirrorOk = true;
    } catch (err) {
      const notFound = err && (err.code === 5 || /\bNOT_FOUND\b/.test(String(err.message || '')));
      if (notFound && !pgOk) {
        // Postgres errored, so it can't say; most likely the note was deleted.
        log.warn({ noteId, workspaceId }, `${name}_note_gone`);
      } else if (notFound) {
        // Postgres just marked this LIVE note failed, yet its doc is missing: a
        // wrong project/database or a half-done deletion, not a deleted note.
        log.error({ err, noteId, workspaceId }, `${name}_mirror_doc_missing`);
      } else {
        log.error({ err, noteId, workspaceId }, `${name}_mirror_failed`);
      }
    }
  }

  // One line per terminal failure, with a stable event name, because this is
  // what the alerting in the runbook counts. Emitted whether or not the writes
  // landed — a note that failed and could not even be marked failed is the
  // worst case, not one to stay quiet about.
  // (Not for an `onlyIfStatus` write that matched nothing: that note was never
  // failed here, and the alert counts this line.)
  if (pgOk || pgErrored || !onlyIfStatus) {
    log.error({ noteId, workspaceId, pgOk, pgErrored, mirrored: shouldMirror, mirrorOk, reason: message }, 'note_failed');
  }
  return { failed: pgOk };
}

module.exports = { markNoteFailed, isFinalAttempt };
