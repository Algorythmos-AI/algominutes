// Bring a finished note's Firestore doc back in line with Postgres.
//
// Postgres is the source of truth and every writer commits there first, then
// mirrors. A mirror write that fails after its commit (a Firestore blip) left
// the doc behind for good: the fast path's `ready` showed as an endless
// spinner, a last attempt's `error` as a note still processing. Nothing else
// revisits a finished note, so the sweep does (db-job `mirror_repair`).
//
// Safe against the writers it races, in this order:
//   1. read the Firestore doc (and its update time);
//   2. read Postgres, in one snapshot;
//   3. act only if Postgres says the note is finished ('ready' | 'error') and
//      the doc disagrees, writing only if the doc hasn't changed since (1)
//      (a lastUpdateTime precondition).
// A writer that commits Postgres before (2) shows in the read (a re-queue
// reads 'queued', not finished, so nothing happens); one that commits after
// (2) mirrors after (1), and the precondition refuses this write.
//
// The clients' Retry is the one writer that goes to the doc first ('queued',
// then /v1/process moves Postgres), so a doc written in the last `settledMs`
// is left alone: a doc behind a lost mirror hasn't been written for that long.
//
// Repairing to 'ready' writes the summary and transcript from Postgres, as
// markSummaryReady does, rather than keeping what the doc has: that can be an
// earlier run's (a regenerate, or a re-queue, whose 'ready' mirror was lost).
// Edits aren't at risk: clients can't write either field (firestore.rules),
// and applyNoteEdit writes Postgres first. Field paths keep summary.keyPoints.

import type { Firestore } from 'firebase-admin/firestore';
import redaction from '@algominutes/ai/redaction.cjs';
import { getPool } from './db';

export interface FinishedNote { noteId: string; workspaceId: string; status: 'ready' | 'error' }

/** Notes that finished between `settledMs + windowMs` and `settledMs` ago, oldest first. */
export async function listRecentlyFinishedNotes(input: { settledMs: number; windowMs: number; limit: number }): Promise<FinishedNote[]> {
  const { rows } = await getPool().query(
    `SELECT id AS "noteId", workspace_id AS "workspaceId", status FROM notes
      WHERE status IN ('ready', 'error') AND deleted_at IS NULL
        AND updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND updated_at > NOW() - (($1::bigint + $2::bigint) * INTERVAL '1 millisecond')
      ORDER BY updated_at LIMIT $3`,
    [input.settledMs, input.windowMs, input.limit],
  );
  return rows;
}

function clock(ms: number | null): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

type Postgres = {
  status: string;
  errorMessage: string | null;
  summary?: { gist: string; actionItems: string[]; keyDecisions: string[]; chapters: unknown[] };
  transcript?: { speaker: string; text: string; time: string }[];
};

/**
 * One snapshot of the note. Its content is read only if `docStatus` disagrees
 * with a 'ready' note: most candidates are in step, and cost one query.
 */
async function readPostgres(noteId: string, workspaceId: string, docStatus: unknown): Promise<Postgres | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: [note] } = await client.query(
      `SELECT status, error_message, summary_manually_edited_at FROM notes
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [noteId, workspaceId],
    );
    if (!note) { await client.query('COMMIT'); return null; }
    const out: Postgres = { status: note.status, errorMessage: note.error_message ?? null };
    if (note.status === 'ready' && docStatus !== 'ready') {
      const [summary, items, decisions, lines] = [
        await client.query('SELECT gist, topics, chapters FROM summaries WHERE note_id = $1', [noteId]),
        await client.query('SELECT text FROM action_items WHERE note_id = $1 ORDER BY created_at, id', [noteId]),
        await client.query('SELECT text FROM key_decisions WHERE note_id = $1 ORDER BY created_at, id', [noteId]),
        await client.query(
          `SELECT speaker_tag, chunk_id, start_ms, text FROM transcript_lines
            WHERE note_id = $1 ORDER BY start_ms, id LIMIT 201`,
          [noteId],
        ),
      ];
      // No summary row (nothing summarised it): the doc's summary is left as is.
      const s = summary.rows[0];
      if (s) {
        // summaries.topics holds the generated action items in order; an edit
        // rewrites only the rows. Rows are read by created_at, then id, as the
        // export and share views read them. One writer's rows share created_at,
        // so among them that's the id's order, not the model's (BLOCKERS).
        const topics = Array.isArray(s.topics) && s.topics.every((t: unknown) => typeof t === 'string') ? s.topics : null;
        out.summary = {
          gist: s.gist || '',
          actionItems: !note.summary_manually_edited_at && topics ? topics : items.rows.map((r) => r.text),
          keyDecisions: decisions.rows.map((r) => r.text),
          chapters: Array.isArray(s.chapters) ? s.chapters : [],
        };
      }
      if (lines.rows.length) {
        // Stored lines are redacted chunk by chunk; this re-runs it across the
        // whole transcript, as the summarizer's preview does, so a private key
        // that spans two chunks is caught too.
        const { texts } = redaction.redactLines(lines.rows.map((l) => String(l.text || '')));
        out.transcript = lines.rows.map((l, i) => {
          // The fast path stores "Speaker: text" with no chunk; a chunked line
          // has a speaker tag (or none).
          const labelled = l.chunk_id == null ? /^([^:\n]{1,40}): ([\s\S]*)$/.exec(texts[i]) : null;
          const speaker = labelled ? String(labelled[1]) : (l.speaker_tag != null ? `Speaker ${l.speaker_tag}` : 'Speaker');
          return { speaker, text: labelled ? String(labelled[2]) : texts[i], time: clock(Number(l.start_ms)) };
        });
      }
    }
    await client.query('COMMIT');
    return out;
  } catch (err: any) {
    // The sweep logs the thrown error; a failed rollback rides along on it.
    await client.query('ROLLBACK').catch((rollbackErr) => { if (err && typeof err === 'object') err.rollbackError = rollbackErr; });
    throw err;
  } finally {
    client.release();
  }
}

export type RepairOutcome = 'in_step' | 'repaired' | 'moved' | 'gone' | 'not_finished' | 'doc_recent';

export async function repairNoteMirror(
  firestore: Firestore,
  input: { noteId: string; workspaceId: string },
  opts: { settledMs?: number; now?: number } = {},
): Promise<RepairOutcome> {
  const settledMs = opts.settledMs ?? 10 * 60 * 1000;
  const ref = firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`);
  const snap = await ref.get();
  if (!snap.exists) return 'gone';
  // A client's Retry writes the doc before Postgres; give it time to land.
  if (snap.updateTime && (opts.now ?? Date.now()) - snap.updateTime.toMillis() < settledMs) return 'doc_recent';
  const doc = snap.data() || {};
  const pg = await readPostgres(input.noteId, input.workspaceId, doc.status);
  if (!pg) return 'gone';
  if (pg.status !== 'ready' && pg.status !== 'error') return 'not_finished';
  if (doc.status === pg.status) return 'in_step';

  const patch: Record<string, unknown> = { status: pg.status, updatedAt: new Date().toISOString() };
  if (pg.status === 'error') patch.errorMessage = pg.errorMessage;
  if (pg.summary) {
    patch['summary.gist'] = pg.summary.gist;
    patch['summary.actionItems'] = pg.summary.actionItems;
    patch['summary.keyDecisions'] = pg.summary.keyDecisions;
    patch['summary.chapters'] = pg.summary.chapters;
  }
  if (pg.transcript) {
    patch.transcript = pg.transcript.slice(0, 200);
    patch.transcriptTruncated = pg.transcript.length > 200;
  }
  try {
    await ref.update(patch, { lastUpdateTime: snap.updateTime });
  } catch (err: any) {
    // FAILED_PRECONDITION: a writer mirrored since the read; it is newer.
    if (err && (err.code === 9 || /FAILED_PRECONDITION/.test(String(err.message)))) return 'moved';
    // NOT_FOUND: the note was deleted since the read.
    if (err && (err.code === 5 || /\bNOT_FOUND\b/.test(String(err.message)))) return 'gone';
    throw err;
  }
  return 'repaired';
}
