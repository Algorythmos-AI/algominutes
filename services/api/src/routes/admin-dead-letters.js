// Dead-letter admin view (A7.4).
//
//   GET  /v1/admin/dead-letters            — list DLQ entries (unresolved first)
//   POST /v1/admin/dead-letters/:id/resolve — mark an entry replayed/resolved
//
// Cloud Tasks has no native dead-letter sink; on a job's final attempt a worker
// records the exhausted job in the dead_letter table so it is never silently
// lost. Payload is job METADATA only (noteId/workspaceId/kind) — never PII.
// Both handlers sit behind authMiddleware + adminMiddleware (see index.js).

import { listDeadLetters, markDeadLetterResolved } from '@algominutes/db';

// pg returns TIMESTAMPTZ as a Date; the DeadLetterEntry contract carries ISO
// strings, so normalise here rather than relying on JSON.stringify incidentals.
function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// Map a dead_letter row onto the DeadLetterEntry contract shape.
function toEntry(row) {
  return {
    id: Number(row.id),
    queue: row.queue,
    noteId: row.note_id ?? null,
    workspaceId: row.workspace_id ?? null,
    error: row.error ?? null,
    attempts: row.attempts ?? null,
    traceId: row.trace_id ?? null,
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
  };
}

export async function listDeadLettersRoute(req, res) {
  const { queue, includeResolved, limit } = req.query || {};
  const parsedLimit = Number(limit);
  const rows = await listDeadLetters({
    queue: typeof queue === 'string' && queue ? queue : undefined,
    includeResolved: includeResolved === 'true' || includeResolved === '1',
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : undefined,
  });
  req.log.info({ count: rows.length }, 'dead_letters_listed');
  return res.json({ deadLetters: rows.map(toEntry) });
}

export async function resolveDeadLetterRoute(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  // resolved_by is the verified admin uid, for an audit trail of who cleared it.
  await markDeadLetterResolved(id, req.uid);
  req.log.info({ deadLetterId: id }, 'dead_letter_resolved');
  return res.json({ ok: true, id });
}
