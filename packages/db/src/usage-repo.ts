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
import ledgerReversal from '@algominutes/db/ledger-reversal.cjs';

// The one copy of the reversal SQL (a failure writes it in its own transaction).
const { reverseNoteUsage } = ledgerReversal as {
  reverseNoteUsage: (
    queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    input: { noteId: string; reason: string; idempotencyKey: string },
  ) => Promise<{ applied: boolean; minutesReversed: number }>;
};

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
 *
 * Keyed per run: the caller's key is suffixed with the note's latest debit (the
 * run being refunded). A per-note key refunded a note's first failed run and
 * then, after its re-queue charged it again, silently refused the next.
 */
export async function reverseUsageForNote(input: {
  noteId: string;
  reason: string;
  /** e.g. `${noteId}:refund:transcode_failed` */
  idempotencyKey: string;
}): Promise<{ applied: boolean; minutesReversed: number }> {
  if (!isPostgresEnabled()) return { applied: false, minutesReversed: 0 };
  return reverseNoteUsage(getPool(), input);
}

/** Net minutes used by a user in a billing period (debits − reversals). */
export async function usedMinutes(
  uid: string,
  billingPeriod: string = currentBillingPeriod(),
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } = getPool(),
): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(minutes), 0)::float AS used
       FROM usage_ledger WHERE uid = $1 AND billing_period = $2`,
    [uid, billingPeriod],
  );
  return Number(rows[0]?.used ?? 0);
}

/**
 * Whether a note's charge still stands: its net in the ledger is above zero
 * (charged, and not refunded). markQueued won't charge such a note again, so a
 * retry of it needs no headroom.
 */
export async function noteChargeStands(noteId: string, workspaceId: string): Promise<boolean> {
  if (!isPostgresEnabled()) return false;
  // Scoped to the workspace: note ids are global, and another workspace's
  // charges are none of the caller's business (CLAUDE.md §1).
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(minutes), 0) > 0 AS stands FROM usage_ledger WHERE note_id = $1 AND workspace_id = $2`,
    [noteId, workspaceId],
  );
  return rows[0]?.stands === true;
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
