/**
 * Internal (not re-exported from index.ts): the usage_ledger debit INSERT, on
 * a pool or on a transaction's client. Services debit through meterMinutes or
 * markQueued, never with a connection of their own.
 */
import type { PoolClient } from 'pg';

/** 'YYYY-MM' in UTC — the monthly quota window key. */
export function currentBillingPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface MeterInput {
  uid: string;
  workspaceId?: string | null;
  noteId?: string | null;
  minutes: number;
  reason?: string;
  /** Stable key so a Cloud Tasks replay does not double-charge, e.g. `${noteId}:ingest`. */
  idempotencyKey: string;
  billingPeriod?: string;
}

/**
 * The debit INSERT, on a pool or on a transaction's client. The ledger's
 * uid, workspace_id and note_id are foreign keys, so a debit for a note must be
 * written after the note row exists: markQueued writes the ingest debit in the
 * transaction that creates it.
 */
export async function insertDebit(
  db: Pick<PoolClient, 'query'>,
  input: MeterInput,
): Promise<{ applied: boolean; id?: number }> {
  const period = input.billingPeriod ?? currentBillingPeriod();
  const { rows } = await db.query(
    `INSERT INTO usage_ledger
       (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, idempotency_key)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.uid,
      input.workspaceId ?? null,
      input.noteId ?? null,
      Math.max(0, input.minutes),
      period,
      input.reason ?? 'ingest',
      input.idempotencyKey,
    ],
  );
  return rows.length ? { applied: true, id: rows[0].id } : { applied: false };
}
