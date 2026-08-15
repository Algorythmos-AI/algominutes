/**
 * dead_letter repo (A7.4) — the DLQ + admin view.
 *
 * Cloud Tasks has no native dead-letter sink; on the FINAL attempt a worker
 * records the exhausted job here so it is never silently lost. Payload is job
 * METADATA only (noteId/workspaceId/kind) — never transcript/PII.
 */
import { getPool, isPostgresEnabled } from './db.js';

export interface DeadLetterInput {
  queue: string; // transcode | summarize | embed | extract | notify
  noteId?: string | null;
  workspaceId?: string | null;
  payload?: unknown; // job metadata only, no PII
  error?: string | null;
  attempts?: number | null;
  traceId?: string | null;
}

/** Record an exhausted job. Best-effort — never throw into the worker's failure path. */
export async function recordDeadLetter(input: DeadLetterInput): Promise<{ id?: number }> {
  if (!isPostgresEnabled()) return {};
  const { rows } = await getPool().query(
    `INSERT INTO dead_letter (queue, note_id, workspace_id, payload, error, attempts, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      input.queue,
      input.noteId ?? null,
      input.workspaceId ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
      input.error ?? null,
      input.attempts ?? null,
      input.traceId ?? null,
    ],
  );
  return { id: rows[0]?.id };
}

export interface DeadLetterRow {
  id: number;
  queue: string;
  note_id: string | null;
  workspace_id: string | null;
  payload: unknown;
  error: string | null;
  attempts: number | null;
  trace_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

/** Admin view. Defaults to unresolved, newest first. */
export async function listDeadLetters(opts: {
  queue?: string;
  includeResolved?: boolean;
  limit?: number;
} = {}): Promise<DeadLetterRow[]> {
  if (!isPostgresEnabled()) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeResolved) clauses.push('resolved_at IS NULL');
  if (opts.queue) {
    params.push(opts.queue);
    clauses.push(`queue = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 200, 1000));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await getPool().query(
    `SELECT * FROM dead_letter ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows as DeadLetterRow[];
}

/** Admin marks an entry replayed/resolved. */
export async function markDeadLetterResolved(id: number, resolvedBy: string): Promise<void> {
  if (!isPostgresEnabled()) return;
  await getPool().query(
    `UPDATE dead_letter SET resolved_at = NOW(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`,
    [id, resolvedBy],
  );
}

/** Count of unresolved entries (for the admin badge / alerting). */
export async function countUnresolvedDeadLetters(): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  const { rows } = await getPool().query(`SELECT COUNT(*)::int AS n FROM dead_letter WHERE resolved_at IS NULL`);
  return rows[0]?.n ?? 0;
}
