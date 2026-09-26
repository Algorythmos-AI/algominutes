'use strict';

/**
 * The "ready" and "failed" notices (A7.3), as an outbox (migration 022).
 *
 * The transaction that makes a note ready or failed writes its notice here too:
 * note-terminal markNoteFailed (in its own statement), notes-repo
 * markSummaryReady and failStuckNote, and pipeline-repo persistFastPathResult.
 * After the commit, the writer enqueues a notify task named after the notice
 * (@algominutes/ai/notify.cjs). The notifier claims the row before it sends and
 * marks it sent after, and the sweep re-enqueues one left unsent, so a crash
 * between the commit and the enqueue no longer loses the push, and a replay no
 * longer sends it twice.
 *
 * One notice per (note, run, summary generation, kind). A replay of the same
 * outcome writes nothing; a re-run (run_seq) or a regenerated summary
 * (summary_generation) is a new outcome.
 *
 * Every function takes a pool or a client, so a writer can call recordNotice
 * inside its transaction.
 */

/** How long the notifier holds a claim before another delivery may take it. */
const CLAIM_LEASE_SECONDS = 120;

const NOTICE_FIELDS = `id, note_id AS "noteId", workspace_id AS "workspaceId", uid, kind, trace_id AS "traceId"`;

/**
 * Write the notice for `kind` on the note as it stands (its author, run and
 * summary generation). Returns the notice, or null when this outcome already
 * has one (or the note isn't in `workspaceId`).
 */
async function recordNotice(queryable, { noteId, workspaceId, kind, traceId = null }) {
  const { rows: [notice] } = await queryable.query(
    `INSERT INTO note_notices (note_id, workspace_id, uid, run_seq, generation, kind, trace_id)
       SELECT id, workspace_id, author_uid, run_seq, summary_generation, $3, $4
         FROM notes WHERE id = $1 AND workspace_id = $2
     ON CONFLICT (note_id, run_seq, generation, kind) DO NOTHING
     RETURNING ${NOTICE_FIELDS}`,
    [noteId, workspaceId, kind, traceId],
  );
  return notice || null;
}

/**
 * The notifier takes the notice before sending it. Returns the notice, or
 * `{ claimed: false, state }` when it mustn't send: 'sent', 'abandoned',
 * 'claimed' (another delivery holds it), 'gone' (the note was deleted) or
 * 'superseded': the note has moved on to a newer run or summary since (a lost
 * "failed" notice re-sent after the user retried would be out of date), so
 * it's given up.
 */
async function claimNotice(queryable, noticeId) {
  const { rows: [notice] } = await queryable.query(
    `UPDATE note_notices nn SET claimed_at = NOW()
       FROM notes n
      WHERE nn.id = $1 AND n.id = nn.note_id
        AND n.run_seq = nn.run_seq AND n.summary_generation = nn.generation
        AND nn.sent_at IS NULL AND nn.abandoned_at IS NULL
        AND (nn.claimed_at IS NULL OR nn.claimed_at < NOW() - make_interval(secs => $2))
      RETURNING nn.id, nn.note_id AS "noteId", nn.workspace_id AS "workspaceId", nn.uid, nn.kind, nn.trace_id AS "traceId"`,
    [noticeId, CLAIM_LEASE_SECONDS],
  );
  if (notice) return { claimed: true, notice };
  const { rows: [superseded] } = await queryable.query(
    `UPDATE note_notices nn SET abandoned_at = NOW()
       FROM notes n
      WHERE nn.id = $1 AND n.id = nn.note_id AND nn.sent_at IS NULL AND nn.abandoned_at IS NULL
        AND (n.run_seq <> nn.run_seq OR n.summary_generation <> nn.generation)
      RETURNING nn.id`,
    [noticeId],
  );
  if (superseded) return { claimed: false, state: 'superseded' };
  const { rows: [row] } = await queryable.query(
    'SELECT sent_at IS NOT NULL AS sent, abandoned_at IS NOT NULL AS abandoned FROM note_notices WHERE id = $1',
    [noticeId],
  );
  const state = !row ? 'gone' : row.sent ? 'sent' : row.abandoned ? 'abandoned' : 'claimed';
  return { claimed: false, state };
}

/** Sent (or nothing to send it to): never sent again. */
async function markNoticeSent(queryable, noticeId) {
  await queryable.query('UPDATE note_notices SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL', [noticeId]);
}

/** A send that failed: let the retry claim it at once. */
async function releaseNotice(queryable, noticeId) {
  await queryable.query('UPDATE note_notices SET claimed_at = NULL WHERE id = $1 AND sent_at IS NULL', [noticeId]);
}

/**
 * Notices the sweep should enqueue again: unsent, unclaimed (or a lapsed
 * claim), at least `minAgeSeconds` old (so a live enqueue has had its chance)
 * and younger than `maxAgeHours` (older ones are abandoned instead).
 */
async function listUnsentNotices(queryable, { minAgeSeconds = 300, maxAgeHours = 24, limit = 200 } = {}) {
  const { rows } = await queryable.query(
    `SELECT ${NOTICE_FIELDS} FROM note_notices
      WHERE sent_at IS NULL AND abandoned_at IS NULL
        AND created_at < NOW() - make_interval(secs => $1)
        AND created_at > NOW() - make_interval(hours => $2)
        AND (claimed_at IS NULL OR claimed_at < NOW() - make_interval(secs => $3))
      ORDER BY created_at LIMIT $4`,
    [minAgeSeconds, maxAgeHours, CLAIM_LEASE_SECONDS, limit],
  );
  return rows;
}

/**
 * Give up on notices unsent after `maxAgeHours`: a push about a recording
 * from yesterday helps nobody. Returns them, for the sweep to log.
 */
async function abandonStaleNotices(queryable, { maxAgeHours = 24 } = {}) {
  const { rows } = await queryable.query(
    `UPDATE note_notices SET abandoned_at = NOW()
      WHERE sent_at IS NULL AND abandoned_at IS NULL AND created_at <= NOW() - make_interval(hours => $1)
      RETURNING ${NOTICE_FIELDS}`,
    [maxAgeHours],
  );
  return rows;
}

/** Notices sent or given up more than `olderThanDays` ago: done with. Returns the count. */
async function pruneOldNotices(queryable, { olderThanDays = 30 } = {}) {
  const { rows } = await queryable.query(
    `WITH gone AS (
       DELETE FROM note_notices
        WHERE COALESCE(sent_at, abandoned_at) < NOW() - make_interval(days => $1)
        RETURNING 1
     ) SELECT COUNT(*)::int AS n FROM gone`,
    [olderThanDays],
  );
  return rows[0].n;
}

module.exports = {
  CLAIM_LEASE_SECONDS,
  pruneOldNotices,
  recordNotice,
  claimNotice,
  markNoticeSent,
  releaseNotice,
  listUnsentNotices,
  abandonStaleNotices,
};
