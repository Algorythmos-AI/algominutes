'use strict';

/**
 * The one copy of a note's refund: a reversal row for its net charge (A7.4),
 * never a delete. Takes a pool or a client, so a failure can write it in the
 * same transaction that fails the note (note-terminal markNoteFailed,
 * notes-repo failStuckNote), under the note's row lock:
 *   - a crash can't leave the failure committed and the refund lost;
 *   - a kickoff (markQueued locks the same row) sees both or neither, so it
 *     can't read the charge as standing and then have it refunded under it;
 *   - two refunds for one failure (the sweep's, a worker's) are serialized,
 *     and the second finds the net at 0.
 *
 * Reverses the NET charge, so a repeat, or a call after an earlier reversal,
 * refunds nothing. Keyed per run: the caller's key is suffixed with the note's
 * latest debit (the run being refunded).
 */
async function reverseNoteUsage(queryable, { noteId, reason, idempotencyKey }) {
  const { rows: [row] } = await queryable.query(
    `SELECT COALESCE(SUM(minutes), 0)::float AS net,
            (SELECT uid FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id DESC LIMIT 1) AS uid,
            (SELECT workspace_id FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id DESC LIMIT 1) AS workspace_id,
            (SELECT billing_period FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id DESC LIMIT 1) AS billing_period,
            (SELECT id FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id DESC LIMIT 1) AS debit_id
       FROM usage_ledger WHERE note_id = $1`,
    [noteId],
  );
  const remaining = Number((row && row.net) || 0);
  if (!row || !row.uid || remaining <= 0) return { applied: false, minutesReversed: 0 };
  const { rows } = await queryable.query(
    `INSERT INTO usage_ledger
       (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, reverses_id, idempotency_key)
     VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      row.uid,
      row.workspace_id || null,
      noteId,
      -remaining,
      row.billing_period || currentBillingPeriod(),
      reason,
      row.debit_id || null,
      `${idempotencyKey}:${row.debit_id}`,
    ],
  );
  return rows.length ? { applied: true, minutesReversed: remaining } : { applied: false, minutesReversed: 0 };
}

// ledger.ts currentBillingPeriod, for a CommonJS caller: 'YYYY-MM' (UTC).
function currentBillingPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { reverseNoteUsage };
