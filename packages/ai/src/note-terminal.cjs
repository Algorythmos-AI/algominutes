'use strict';

/**
 * Terminal failure state for a note — written to BOTH stores.
 *
 * This existed only in the summarizer. The transcoder caught, logged and
 * returned 500, and its `mirrorError` writes Firestore alone — so after a
 * permanent failure Firestore said `error` while Postgres stayed `transcribing`
 * forever. `/api/note`, which the iOS app reads, serves the Postgres status, so
 * the two clients disagreed about whether a consultation had failed and the
 * note showed a spinner that would never resolve. There is no server-side
 * sweeper, and the client watchdog only ticks while the app is foregrounded.
 *
 * Both stores are injected because each service builds its own pool and
 * Firestore handle; the point of sharing this is one copy of the SQL, the
 * status guard, and the never-throw discipline.
 */

/**
 * Cloud Tasks reports the attempt in `X-CloudTasks-TaskRetryCount`, 0-based.
 * The queue is created with `--max-attempts=5` (scripts/gcp-bootstrap.sh), so
 * attempt 4 is the last one. Marking earlier would turn a transient blip into a
 * permanent failure the doctor has to act on.
 */
function isFinalAttempt(headers, maxAttempts = 5) {
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
  try {
    const client = await pool.connect();
    try {
      const { rowCount } = await client.query(
        `UPDATE notes SET status = 'error', error_message = $2, updated_at = NOW()
          WHERE id = $1 AND status <> 'ready'`,
        [noteId, message],
      );
      pgOk = rowCount > 0;
    } finally {
      client.release();
    }
  } catch (err) {
    log.error({ err, noteId, workspaceId }, `${name}_pg_failed`);
  }

  let mirrorOk = false;
  try {
    await firestore.doc(`workspaces/${workspaceId}/notes/${noteId}`).set(
      { status: 'error', errorMessage: message, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    mirrorOk = true;
  } catch (err) {
    log.error({ err, noteId, workspaceId }, `${name}_mirror_failed`);
  }

  // One line per terminal failure, with a stable event name, because this is
  // what the alerting in the runbook counts. Emitted whether or not the writes
  // landed — a note that failed and could not even be marked failed is the
  // worst case, not one to stay quiet about.
  log.error({ noteId, workspaceId, pgOk, mirrorOk, reason: message }, 'note_failed');
}

module.exports = { markNoteFailed, isFinalAttempt };
