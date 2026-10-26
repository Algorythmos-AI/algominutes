/**
 * Lost pipeline work, found and claimed for the sweep to re-drive (RELEASE.md PR 5c; audit Q9–Q11).
 *
 * A summarizer or embedder task is enqueued after the commit that claims it (pipeline-repo
 * claimSummarizerEnqueue / claimEmbedderEnqueue, completeChunkGate). An enqueue that throws after its claim, or
 * a task lost to a crash, leaves the claim set and no task: the note sat at 'summarizing' until the stuck-note
 * sweep failed it (3.5 h), or went 'ready' and was never embedded, so search never found it.
 *
 * Each claim here re-stamps the enqueue time in the same statement (FOR UPDATE SKIP LOCKED), so a note is
 * re-driven at most once per REDRIVE window, and the sweep's advisory lock keeps two sweeps apart. A duplicate
 * delivery is harmless: the summarizer's write is guarded by its generation and once-per-summary notice, and
 * the embedder's rows are upserted.
 */
import { getPool, isPostgresEnabled } from './db.js';

export interface LostRun {
  noteId: string;
  workspaceId: string;
  uid: string;
  runSeq: number;
}

/**
 * Pipeline summaries whose task was lost: 'summarizing' (not a regeneration: its summary_requested_at is set,
 * and the api enqueued it), claimed longer ago than `olderThanMs`, and untouched since. `olderThanMs` should
 * outlast the summarize queue's own retries, so a task still retrying isn't doubled.
 */
export async function claimLostSummaries(opts: { olderThanMs: number; limit: number }): Promise<LostRun[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `UPDATE notes n SET summarizer_enqueued_at = NOW()
      WHERE n.id IN (
        SELECT id FROM notes
         WHERE status = 'summarizing' AND deleted_at IS NULL
           AND summary_requested_at IS NULL
           AND summarizer_enqueued_at IS NOT NULL
           AND summarizer_enqueued_at < NOW() - make_interval(secs => $1::float8 / 1000)
           AND updated_at < NOW() - make_interval(secs => $1::float8 / 1000)
         ORDER BY summarizer_enqueued_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.workspace_id, n.author_uid, n.run_seq`,
    [opts.olderThanMs, opts.limit],
  );
  return rows.map((r: any) => ({ noteId: r.id, workspaceId: r.workspace_id, uid: r.author_uid, runSeq: Number(r.run_seq) }));
}

/**
 * Ready notes whose embed was lost: claimed between `olderThanMs` and `withinMs` ago, with a transcript but no
 * embeddings, and no unresolved embed dead letter (an embed that failed for good is the admin's, not a
 * re-drive's). The window bounds how often one note is tried.
 */
export async function claimLostEmbeds(opts: { olderThanMs: number; withinMs: number; limit: number }): Promise<LostRun[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `UPDATE notes n SET embedder_enqueued_at = NOW()
      WHERE n.id IN (
        SELECT c.id FROM notes c
         WHERE c.status = 'ready' AND c.deleted_at IS NULL
           AND c.embedder_enqueued_at IS NOT NULL
           AND c.embedder_enqueued_at < NOW() - make_interval(secs => $1::float8 / 1000)
           AND c.embedder_enqueued_at > NOW() - make_interval(secs => $2::float8 / 1000)
           AND EXISTS (SELECT 1 FROM transcript_lines t WHERE t.note_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.note_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM dead_letter d WHERE d.note_id = c.id AND d.queue = 'embed' AND d.resolved_at IS NULL)
         ORDER BY c.embedder_enqueued_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING n.id, n.workspace_id, n.author_uid, n.run_seq`,
    [opts.olderThanMs, opts.withinMs, opts.limit],
  );
  return rows.map((r: any) => ({ noteId: r.id, workspaceId: r.workspace_id, uid: r.author_uid, runSeq: Number(r.run_seq) }));
}
