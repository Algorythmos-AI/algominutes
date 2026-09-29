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
  /** The chunk the lost work was for (a poll), part of the dedupe key. */
  chunkId?: string | null;
  /** Why, as a stable code (stt_poll_exhausted, transcode_failed, ...). */
  reason?: string | null;
}

/**
 * The dedupe key's SQL, from a notes row `n` (migration 027): the queue, the note, its current run, its summary
 * generation (a regeneration that fails is its own loss) and the chunk. note-terminal.cjs builds the same key
 * when it writes the dead letter with the failure.
 */
export const deadLetterKeySql = (queue: string, chunk: string) =>
  `${queue}::text || ':' || n.id || ':' || n.run_seq || ':' || n.summary_generation || ':' || COALESCE(${chunk}::text, '')`;

/** Postgres refuses U+0000 in text and jsonb; tool output can carry it. Stripped from strings before serialising. */
const withoutNul = (text: string) => text.replace(/\u0000/g, '');
const payloadJson = (payload: unknown) => JSON.stringify(payload, (_k, v) => (typeof v === 'string' ? withoutNul(v) : v));

/**
 * Record an exhausted job, once (migration 027): a second record of the same queue's work on the same run
 * and chunk (a replayed last attempt, a re-driven poll, or the dead letter markNoteFailed already wrote with
 * the failure) writes nothing and says so (`duplicate`). A note that can't be read (gone) gets a row with no
 * key, never deduped. Best-effort — callers never let it throw into the worker's failure path.
 */
export async function recordDeadLetter(input: DeadLetterInput): Promise<{ id?: number; duplicate?: boolean }> {
  if (!isPostgresEnabled()) return {};
  const params = [
    input.queue,
    input.noteId ?? null,
    input.workspaceId ?? null,
    input.payload ? payloadJson(input.payload) : null,
    input.error != null ? withoutNul(input.error) : null,
    input.attempts ?? null,
    input.traceId ?? null,
    input.reason ?? null,
    input.chunkId ?? null,
  ];
  const { rows } = await getPool().query(
    `INSERT INTO dead_letter (queue, note_id, workspace_id, payload, error, attempts, trace_id, reason, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT ${deadLetterKeySql('$1', '$9')} FROM notes n WHERE n.id = $2 AND n.workspace_id = $3))
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    params,
  );
  if (rows[0]) return { id: Number(rows[0].id) };
  const { rows: [kept] } = await getPool().query(
    `SELECT d.id FROM dead_letter d, notes n
      WHERE n.id = $2 AND n.workspace_id = $3 AND d.dedupe_key = ${deadLetterKeySql('$1', '$4')}`,
    [input.queue, input.noteId ?? null, input.workspaceId ?? null, input.chunkId ?? null],
  );
  return { id: kept ? Number(kept.id) : undefined, duplicate: true };
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
