'use strict';

const { reverseNoteUsage } = require('./ledger-reversal.cjs');

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
 * A note already 'error' keeps its first message: the user was told that one.
 *
 * Returns `{ failed, marked, pgErrored, exists }`:
 * - `marked`: Postgres has the note at 'error' after this write (new or not).
 *   The refund keys on this: it's net-guarded, so repeating it changes nothing.
 *   With `refund` ({ reason, idempotencyKey }), the reversal is written in the
 *   same transaction as the failure, under the note's row lock
 *   (ledger-reversal.cjs): a crash can't commit one without the other, and a
 *   kickoff or a second refunder sees both or neither.
 * - `failed`: this write moved the note to 'error' from something else. The
 *   "failed" notice keys on this, so the author is told once.
 * - `pgErrored`: Postgres couldn't be asked.
 * - `exists`: the note is there in this workspace (ready, already failed, ...).
 * - `refunded`: a reversal was written (the note still had a net charge).
 */
async function markNoteFailed({ pool, firestore, noteId, workspaceId, message, log, event, retryOnPgError = false, onlyIfStatus = null, chunkId = null, refund = null }) {
  const name = event || 'note_marked_failed';
  if (!noteId || !workspaceId) {
    log.error({ noteId, workspaceId }, `${name}_missing_ids`);
    return { failed: false, marked: false, pgErrored: false, exists: false, refunded: false };
  }

  let pgOk = false;
  let pgErrored = false;
  let prevStatus = null;
  let storedMessage = message;
  let exists = false;
  let refunded = false;
  try {
    const client = await pool.connect();
    try {
      if (refund) await client.query('BEGIN');
      let rows;
      try {
        // Scoped to the payload's workspace (CLAUDE.md §1 multi-tenancy): a note
        // id from another workspace matches nothing. `p` reads the status the
        // UPDATE replaces, locked, so of two failures at once the second reads
        // the first's 'error'. With `chunkId`, the chunk's error is written in
        // the same statement, and only if the note's was: a poll's retry finds
        // both or neither, and a note this doesn't fail keeps its chunk.
        ({ rows } = await client.query(
          `WITH p AS (
             SELECT id, status AS prev_status FROM notes
              WHERE id = $1 AND workspace_id = $3 FOR NO KEY UPDATE
           ), upd AS (
             UPDATE notes n SET status = 'error',
                    error_message = CASE WHEN p.prev_status = 'error' AND n.error_message IS NOT NULL
                                         THEN n.error_message ELSE $2 END,
                    updated_at = NOW()
               FROM p
              WHERE n.id = p.id AND n.status <> 'ready'
                AND ($4::text[] IS NULL OR n.status = ANY($4::text[]))
              RETURNING n.id, p.prev_status, n.error_message
           ), chunk AS (
             UPDATE audio_chunks c SET status = 'error' FROM upd WHERE c.id = $5 AND c.note_id = upd.id
           )
           SELECT prev_status, error_message FROM upd`,
          [noteId, message, workspaceId, onlyIfStatus, chunkId],
        ));
        // The refund in the failure's transaction, while its row lock holds.
        if (refund && rows.length > 0) {
          refunded = (await reverseNoteUsage(client, {
            noteId, reason: refund.reason, idempotencyKey: refund.idempotencyKey,
          })).applied;
        }
        if (refund) await client.query('COMMIT');
      } catch (err) {
        refunded = false;
        if (refund) {
          await client.query('ROLLBACK').catch((rollbackErr) => log.error({ err: rollbackErr, noteId, workspaceId }, `${name}_rollback_failed`));
        }
        throw err;
      }
      pgOk = rows.length > 0;
      prevStatus = pgOk ? rows[0].prev_status : null;
      if (pgOk && rows[0].error_message) storedMessage = rows[0].error_message;
      exists = pgOk;
      if (!pgOk) {
        // Its own try: the UPDATE succeeded (it matched nothing), so a failure
        // here isn't a Postgres error on the failure, and mustn't mirror one.
        try {
          exists = (await client.query(
            'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2', [noteId, workspaceId],
          )).rowCount > 0;
        } catch (probeErr) {
          log.error({ err: probeErr, noteId, workspaceId }, `${name}_exists_probe_failed`);
          exists = true; // unknown: keep the dead letter
        }
      }
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
        { status: 'error', errorMessage: storedMessage, updatedAt: new Date().toISOString() },
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
  // Only for a new failure: not a note already 'error' (re-marked), and not one
  // this matched nothing on (ready, gone, or an `onlyIfStatus` miss), since the
  // alert counts this line.
  const failed = pgOk && prevStatus !== 'error';
  if (failed || pgErrored) {
    log.error({ noteId, workspaceId, pgOk, pgErrored, mirrored: shouldMirror, mirrorOk, reason: message }, 'note_failed');
  } else {
    log.info({ noteId, workspaceId, pgOk, prevStatus, exists }, `${name}_not_a_new_failure`);
  }
  if (refund && pgOk) {
    log.info({ noteId, workspaceId, applied: refunded, reason: refund.reason }, 'usage_refunded');
  }
  return { failed, marked: pgOk, pgErrored, exists, refunded };
}

module.exports = { markNoteFailed, isFinalAttempt };
