/**
 * usage_ledger repo (A9.1 / A7.4) — the metered-minutes ledger.
 *
 * Append-only and idempotent under Cloud Tasks replay (every write carries a
 * UNIQUE idempotency_key; a replay is a no-op via ON CONFLICT). Refunds are
 * REVERSAL rows (A7.4), never deletes: net minutes in a period = SUM(minutes)
 * with debits positive and reversals negative.
 *
 * Distinct from usage_events (001_init), which is COGS attribution. This ledger
 * is what the user consumed against their plan quota.
 */
import { getPool, isPostgresEnabled } from './db.js';
import { currentBillingPeriod, insertDebit, type MeterInput } from './ledger.js';

export { currentBillingPeriod, type MeterInput } from './ledger.js';

/**
 * Append a debit (minutes consumed). Idempotent: a second call with the same
 * idempotency_key inserts nothing. Returns whether a new row was written.
 */
export async function meterMinutes(input: MeterInput): Promise<{ applied: boolean; id?: number }> {
  if (!isPostgresEnabled()) return { applied: false };
  return insertDebit(getPool(), input);
}

/**
 * Refund a note's metered minutes on pipeline failure (A7.4) — a reversal row,
 * never a delete. Reverses the note's current NET debit (so repeated calls with
 * the same idempotency_key, or after a prior reversal, do not over-refund).
 */
export async function reverseUsageForNote(input: {
  noteId: string;
  reason: string;
  /** e.g. `${noteId}:refund:transcode_failed` */
  idempotencyKey: string;
}): Promise<{ applied: boolean; minutesReversed: number }> {
  if (!isPostgresEnabled()) return { applied: false, minutesReversed: 0 };
  const pool = getPool();
  // Net minutes still charged for this note (debits + prior reversals).
  const net = await pool.query(
    `SELECT COALESCE(SUM(minutes), 0)::float AS net,
            (SELECT uid FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id LIMIT 1) AS uid,
            (SELECT workspace_id FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id LIMIT 1) AS workspace_id,
            (SELECT billing_period FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id LIMIT 1) AS billing_period,
            (SELECT id FROM usage_ledger WHERE note_id = $1 AND entry_type='debit' ORDER BY id LIMIT 1) AS debit_id
       FROM usage_ledger WHERE note_id = $1`,
    [input.noteId],
  );
  const row = net.rows[0];
  const remaining = Number(row?.net ?? 0);
  if (!row || !row.uid || remaining <= 0) return { applied: false, minutesReversed: 0 };
  const { rows } = await pool.query(
    `INSERT INTO usage_ledger
       (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, reverses_id, idempotency_key)
     VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      row.uid,
      row.workspace_id ?? null,
      input.noteId,
      -remaining,
      row.billing_period ?? currentBillingPeriod(),
      input.reason,
      row.debit_id ?? null,
      input.idempotencyKey,
    ],
  );
  return rows.length ? { applied: true, minutesReversed: remaining } : { applied: false, minutesReversed: 0 };
}

/** Net minutes used by a user in a billing period (debits − reversals). */
export async function usedMinutes(uid: string, billingPeriod: string = currentBillingPeriod()): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(minutes), 0)::float AS used
       FROM usage_ledger WHERE uid = $1 AND billing_period = $2`,
    [uid, billingPeriod],
  );
  return Number(rows[0]?.used ?? 0);
}

/**
 * Drop paid-work records (usage_events, written by the transcoder for the §4.6
 * spend cap) older than olderThanDays. The cap reads only the last 24 hours;
 * the rest is kept a while for cost attribution. Returns how many went.
 */
export async function pruneUsageEvents(input: { olderThanDays: number }): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rowCount } = await getPool().query(
    `DELETE FROM usage_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [input.olderThanDays],
  );
  return rowCount ?? 0;
}
