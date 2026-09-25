/**
 * Note dual-write layer.
 *
 * Postgres is the system of record. Firestore is a denormalized cache
 * for the live UI. Every mutation in the hot path goes through this
 * module so Postgres and Firestore stay in lockstep.
 *
 * When WRITE_POSTGRES is off, all Postgres writes are no-ops and only
 * the Firestore mirror runs — making the layer safe to deploy before
 * the Cloud SQL instance exists.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getPool, isPostgresEnabled, withTx } from './db';
import { ensureUser, ensureWorkspaceAccess, WorkspaceBoundaryError } from './workspace-access';
import { insertDebit } from './ledger';
import { lockNoteId } from './note-lock';
// Shared, Postgres-only edit writer. Same module the deployed Cloud Function
// (functions/index.js exports.updateNote) uses, so the edit SQL lives in one
// place. Imported as a default (CJS) — see server.ts for the same pattern.
// Ported from the original app: note-edit.cjs now lives in @algominutes/ai.
import noteEditShared from '@algominutes/ai/note-edit.cjs';
const { writeNoteEditWithinTx } = noteEditShared as {
  writeNoteEditWithinTx: (
    client: import('pg').PoolClient,
    edit: { noteId: string; workspaceId: string; title?: string; summary?: NoteEditSummary },
  ) => Promise<{ pgRowPresent: boolean }>;
};

export interface MarkReadyInput {
  noteId: string;
  workspaceId: string;
  authorUid: string;
  sourceType: string;
  storagePath?: string;
  mimeType?: string;
  durationSec?: number;
  summary: {
    gist: string;
    actionItems: string[];
    keyDecisions: string[];
  };
  transcript: { speaker: string; text: string; time: string }[];
  model?: string | null;
}

export interface MarkErrorInput {
  noteId: string;
  workspaceId: string;
  errorMessage: string;
}

export interface MarkQueuedInput {
  noteId: string;
  workspaceId: string;
  authorUid: string;
  authorEmail?: string | null;
  authorName?: string | null;
  sourceType: string;
  storagePath?: string | null;
  sourceUrl?: string | null;
  mimeType?: string | null;
  /**
   * The ingest debit, written in the queue transaction: after the note row
   * exists (usage_ledger.note_id is a foreign key), and only when this call
   * actually queues. A duplicate or refused kickoff debits nothing.
   */
  meter?: { minutes: number; idempotencyKey: string };
}

export interface NoteEditSummary {
  gist: string;
  actionItems: string[];
  keyDecisions: string[];
  keyPoints?: string[];
}

export interface ApplyNoteEditInput {
  noteId: string;
  workspaceId: string;
  title?: string;
  summary?: NoteEditSummary;
}

const ISO_NOW = () => new Date().toISOString();

function timeStrToMs(t: string): number {
  if (!t) return 0;
  const parts = t.split(':').map((n) => Number(n) || 0);
  const [a = 0, b = 0, c = 0] = parts;
  if (parts.length === 3) return ((a * 60 + b) * 60 + c) * 1000;
  if (parts.length === 2) return (a * 60 + b) * 1000;
  return a * 1000;
}

/** Thrown when a write would cross a workspace boundary (CLAUDE.md §1 multi-tenancy). */
export { WorkspaceBoundaryError, AccountDeletedError } from './workspace-access';


async function upsertCoreToPostgres(
  input: MarkReadyInput,
  log: { error: (o: any, m?: string) => void },
): Promise<void> {
  if (!isPostgresEnabled()) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ensure user + workspace exist (Firebase Auth is the source of identity,
    // but we want FK targets here). Through ensureUser, so a deleted account is
    // refused rather than re-created.
    await ensureUser(client, { uid: input.authorUid });
    // Bootstrap a brand-new workspace with the author as owner, but NEVER add
    // the author to a workspace that already exists unless they are already a
    // member (pinned in tests/integration/tenant-isolation.test.ts).
    await ensureWorkspaceAccess(client, input.workspaceId, input.authorUid, 'My Workspace');

    const noteRow = await client.query(
      `INSERT INTO notes (
         id, workspace_id, author_uid, status, source_type,
         storage_path, mime_type, duration_sec, updated_at
       ) VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE
         SET status        = EXCLUDED.status,
             storage_path  = COALESCE(EXCLUDED.storage_path, notes.storage_path),
             mime_type     = COALESCE(EXCLUDED.mime_type, notes.mime_type),
             duration_sec  = COALESCE(EXCLUDED.duration_sec, notes.duration_sec),
             updated_at    = NOW()
         -- An existing note id in ANOTHER workspace must never be overwritten.
         WHERE notes.workspace_id = EXCLUDED.workspace_id
       RETURNING id`,
      [
        input.noteId,
        input.workspaceId,
        input.authorUid,
        input.sourceType,
        input.storagePath || null,
        input.mimeType || null,
        input.durationSec || null,
      ],
    );
    if (!noteRow.rowCount) {
      throw new WorkspaceBoundaryError(`note ${input.noteId} belongs to a different workspace`);
    }

    await client.query(
      `INSERT INTO summaries (note_id, gist, model, generated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (note_id) DO UPDATE
         SET gist = EXCLUDED.gist, model = EXCLUDED.model, generated_at = NOW()`,
      [input.noteId, input.summary.gist, input.model || null],
    );

    // Replace transcript + action items + key decisions atomically.
    await client.query('DELETE FROM transcript_lines WHERE note_id = $1', [input.noteId]);
    for (const line of input.transcript || []) {
      const ms = timeStrToMs(line.time);
      await client.query(
        `INSERT INTO transcript_lines (note_id, speaker_name, start_ms, end_ms, text)
           VALUES ($1, $2, $3, $4, $5)`,
        [input.noteId, line.speaker || null, ms, ms, line.text || ''],
      );
    }
    await client.query('DELETE FROM action_items WHERE note_id = $1', [input.noteId]);
    for (const text of input.summary.actionItems || []) {
      await client.query(
        `INSERT INTO action_items (note_id, text) VALUES ($1, $2)`,
        [input.noteId, text],
      );
    }
    await client.query('DELETE FROM key_decisions WHERE note_id = $1', [input.noteId]);
    for (const text of input.summary.keyDecisions || []) {
      await client.query(
        `INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)`,
        [input.noteId, text],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client
      .query('ROLLBACK')
      .catch((rollbackErr) =>
        log.error({ err: rollbackErr, noteId: input.noteId, workspaceId: input.workspaceId }, 'pg_rollback_failed'),
      );
    throw err;
  } finally {
    client.release();
  }
}

/** Pipeline statuses between kickoff and a terminal 'ready' / 'error'. */
export const IN_FLIGHT_STATUSES = ['queued', 'chunking', 'transcribing', 'summarizing'] as const;
/**
 * An in-flight note whose status hasn't changed for this long is treated as
 * stuck, and may be re-queued. updated_at is bumped on every status change
 * (transcoder upsertNoteStatus), so this measures time in the CURRENT status.
 * It must exceed the longest a live job can dwell in one status: STT polling is
 * capped at MAX_STT_POLLS x 60 s = 2 h, and then the transcoder fails the note
 * itself (pinned by tests/pipeline-timeouts.test.ts). The stuck-note sweeper
 * (plan PR-15) replaces this heuristic.
 */
export const IN_FLIGHT_STALE_MS = 3 * 60 * 60 * 1000;

export interface NoteQueueState {
  /** The id exists in ANOTHER workspace (Postgres note ids are global). */
  foreign: boolean;
  /** Already being processed (and not stale): a duplicate kickoff must not reset it. */
  inFlight: boolean;
  status: string | null;
}

function queueStateOf(
  row: { workspace_id: string; status: string; updated_at: Date } | undefined,
  workspaceId: string,
  now: Date,
): NoteQueueState {
  if (!row) return { foreign: false, inFlight: false, status: null };
  if (row.workspace_id !== workspaceId) return { foreign: true, inFlight: false, status: null };
  const fresh = now.getTime() - new Date(row.updated_at).getTime() < IN_FLIGHT_STALE_MS;
  const inFlight = (IN_FLIGHT_STATUSES as readonly string[]).includes(row.status) && fresh;
  return { foreign: false, inFlight, status: row.status };
}

/**
 * Read-only pre-check for POST /v1/process, run before rate limits and
 * metering, so a foreign or duplicate request costs the caller nothing.
 * markQueued re-checks atomically; this one only saves the work.
 */
export async function getNoteQueueState(
  input: { noteId: string; workspaceId: string },
  now: Date = new Date(),
): Promise<NoteQueueState> {
  if (!isPostgresEnabled()) return { foreign: false, inFlight: false, status: null };
  const { rows } = await getPool().query(
    'SELECT workspace_id, status, updated_at FROM notes WHERE id = $1',
    [input.noteId],
  );
  return queueStateOf(rows[0], input.workspaceId, now);
}

/**
 * Queue a note for processing (POST /v1/process). Postgres first (system of
 * record), then the Firestore 'queued' mirror.
 *
 * Tenant boundary: Firestore note ids are scoped per workspace, but
 * Postgres notes.id is GLOBAL. So a caller can create a Firestore doc in their
 * own workspace whose id collides with another tenant's note. The upsert
 * therefore only updates an existing row in the SAME workspace; otherwise it
 * throws WorkspaceBoundaryError and touches nothing. (Previously this SQL lived
 * in the api route with no such guard: another tenant's note was reset,
 * re-pointed at the caller's audio, and its audio_chunks deleted. The
 * regression test is in tests/integration/tenant-isolation.test.ts.)
 *
 * A re-queue of the caller's own note is a fresh start: processing counters
 * are reset and the previous run's audio_chunks are deleted in the same
 * transaction.
 */
export async function markQueued(
  firestore: Firestore,
  input: MarkQueuedInput,
  log: { error: (o: any, m?: string) => void },
  now: Date = new Date(),
): Promise<{ queued: boolean; status: string | null; deleted?: true }> {
  const noteDoc = firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`);
  if (isPostgresEnabled()) {
    const outcome = await withTx(
      async (client): Promise<{ queued: boolean; status: string | null; deleted?: true }> => {
        // Serialize kickoffs for this note id, including a brand-new note with
        // no row to lock yet: the second of two concurrent duplicates waits
        // here, then sees the first's 'queued' row and backs off. deleteNote
        // takes the same lock, so a deletion either committed before this
        // point or waits until this transaction ends.
        await lockNoteId(client, input.noteId);
        // No row: a note never queued, or one deleted since the route read its
        // doc. A deletion leaves a purge row until the doc and the audio are
        // gone, and after that the doc is missing. Either way it stays deleted:
        // the INSERT below would bring the row back. Checked before any row
        // lock, so the Firestore read holds only the note lock. (A row can't
        // vanish meanwhile: deleteNote waits for that lock.)
        const hasRow = await client.query('SELECT 1 FROM notes WHERE id = $1', [input.noteId]);
        if (!hasRow.rowCount) {
          const purging = await client.query(
            'SELECT 1 FROM storage_purges WHERE note_id = $1 AND workspace_id = $2 LIMIT 1',
            [input.noteId, input.workspaceId],
          );
          if (purging.rowCount || !(await noteDoc.get()).exists) {
            return { queued: false, status: null, deleted: true };
          }
        }
        // The user row first, then the note row: the same order account
        // deletion takes them (users FOR UPDATE, then the cascade to notes), so
        // the two can't deadlock. It also refuses a deleted account.
        await ensureUser(client, { uid: input.authorUid, email: input.authorEmail, name: input.authorName });
        const existing = await client.query(
          'SELECT workspace_id, status, updated_at FROM notes WHERE id = $1 FOR UPDATE',
          [input.noteId],
        );
        const state = queueStateOf(existing.rows[0], input.workspaceId, now);
        if (state.foreign) {
          throw new WorkspaceBoundaryError(`note ${input.noteId} belongs to a different workspace`);
        }
        if (state.inFlight) {
          // Idempotent: a duplicate kickoff (e.g. a client retry after a
          // timeout) must not reset the running job or delete its chunks.
          return { queued: false, status: state.status };
        }

        await ensureWorkspaceAccess(
          client,
          input.workspaceId,
          input.authorUid,
          input.authorName ? `${input.authorName}'s Workspace` : 'My Workspace',
        );
        const noteRow = await client.query(
          `INSERT INTO notes (id, workspace_id, author_uid, status, source_type, storage_path, source_url, mime_type)
             VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             status = 'queued',
             source_type = EXCLUDED.source_type,
             storage_path = COALESCE(EXCLUDED.storage_path, notes.storage_path),
             source_url   = COALESCE(EXCLUDED.source_url, notes.source_url),
             mime_type    = COALESCE(EXCLUDED.mime_type, notes.mime_type),
             summarizer_enqueued_at = NULL,
             embedder_enqueued_at = NULL,
             chunks_done = 0,
             chunks_total = NULL,
             duration_sec_probed = NULL,
             error_message = NULL,
             updated_at = NOW()
           -- An existing note id in ANOTHER workspace must never be touched.
           WHERE notes.workspace_id = EXCLUDED.workspace_id
           RETURNING id`,
          [
            input.noteId,
            input.workspaceId,
            input.authorUid,
            input.sourceType,
            input.storagePath || null,
            input.sourceUrl || null,
            input.mimeType || null,
          ],
        );
        if (!noteRow.rowCount) {
          throw new WorkspaceBoundaryError(`note ${input.noteId} belongs to a different workspace`);
        }
        // Safe only after the boundary check above, in the same transaction.
        await client.query('DELETE FROM audio_chunks WHERE note_id = $1', [input.noteId]);
        if (input.meter) {
          // Idempotent by key: a re-queue of the same note isn't charged twice.
          await insertDebit(client, {
            uid: input.authorUid,
            workspaceId: input.workspaceId,
            noteId: input.noteId,
            minutes: input.meter.minutes,
            reason: 'ingest',
            idempotencyKey: input.meter.idempotencyKey,
          });
        }
        return { queued: true, status: 'queued' };
      },
      { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
    );
    if (!outcome.queued) return outcome;
  }

  // update(), never a merge-set: a doc deleted after the commit above must not
  // be re-created.
  try {
    await noteDoc.update({ status: 'queued', updatedAt: ISO_NOW() });
  } catch (err) {
    if (!isFirestoreNotFound(err)) throw err;
    // deleteNote (and account deletion) waited for this transaction and then
    // removed the row as well: the note is deleted, and nothing is enqueued.
    // A live row means the doc went some other way (a legacy client deleting
    // it directly, or a misconfigured project): throw, so the caller fails
    // the note instead of leaving it 'queued' with no job.
    if (isPostgresEnabled()) {
      const live = await getPool().query(
        'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2',
        [input.noteId, input.workspaceId],
      );
      if (live.rowCount) throw err;
    }
    return { queued: false, status: null, deleted: true };
  }
  return { queued: true, status: 'queued' };
}

export type SummaryClaim =
  | { claimed: true; generation: number; template: string }
  | { claimed: false; reason: 'not_found' }
  | { claimed: false; reason: 'manual_edits_present'; editedAt: string }
  | { claimed: false; reason: 'already_regenerating'; status: string };

/**
 * Claim a note for summary regeneration (POST /v1/notes/regenerate-summary).
 * One conditional UPDATE is both the claim and the double-tap guard: it only
 * matches a note in the caller's workspace that is 'ready' or 'error', or one
 * stuck in 'summarizing' for more than 15 minutes (stale-lock takeover, so a
 * summarizer that dies mid-run can't strand it). Manual edits block the claim
 * unless the caller confirmed overwriting them. When the claim fails, a probe
 * says why, so the client can offer the right next step.
 */
export async function claimSummaryRegeneration(input: {
  noteId: string;
  workspaceId: string;
  template?: string | null;
  confirmOverwrite?: boolean;
}): Promise<SummaryClaim> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE notes
        SET summary_generation = summary_generation + 1,
            summary_template = COALESCE($3, summary_template),
            summary_requested_at = NOW(),
            status = 'summarizing',
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        AND (status IN ('ready', 'error')
             OR (status = 'summarizing'
                 AND summary_requested_at < NOW() - INTERVAL '15 minutes'))
        AND ($4::boolean IS TRUE OR summary_manually_edited_at IS NULL)
      RETURNING summary_generation, summary_template`,
    [input.noteId, input.workspaceId, input.template ? String(input.template) : null, input.confirmOverwrite === true],
  );
  if (rows[0]) {
    return { claimed: true, generation: rows[0].summary_generation, template: rows[0].summary_template };
  }
  const probe = await pool.query(
    `SELECT status, summary_manually_edited_at FROM notes
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [input.noteId, input.workspaceId],
  );
  const row = probe.rows[0];
  if (!row) return { claimed: false, reason: 'not_found' };
  if (row.summary_manually_edited_at && input.confirmOverwrite !== true) {
    return {
      claimed: false,
      reason: 'manual_edits_present',
      editedAt: new Date(row.summary_manually_edited_at).toISOString(),
    };
  }
  return { claimed: false, reason: 'already_regenerating', status: row.status };
}

/**
 * Hand a claimed note back (the regenerate task could not be enqueued), so it
 * is not stuck in 'summarizing' waiting for a task that will never arrive.
 * Scoped to the caller's workspace, and only if it is still in 'summarizing'
 * at the generation this claim minted.
 *
 * It also undoes the claim's generation bump. No task carries that generation,
 * and leaving it bumped would make a run still in flight from before a
 * stale-lock takeover count as superseded, so its summary would be discarded
 * (markSummaryReady only writes at the generation the run read).
 */
export async function releaseSummaryClaim(input: { noteId: string; workspaceId: string; generation: number }): Promise<void> {
  await getPool().query(
    `UPDATE notes
        SET status = 'ready',
            summary_generation = summary_generation - 1,
            updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND status = 'summarizing'
        AND summary_generation = $3`,
    [input.noteId, input.workspaceId, input.generation],
  );
}

/**
 * Firestore half of a regeneration: Postgres was set to 'summarizing' by
 * claimSummaryRegeneration. Call it ONLY after a successful claim (and once the
 * task is enqueued), so the live UI shows the note regenerating. On its own it
 * would be a one-sided write. It is split out only so the enqueue can sit
 * between the two halves.
 */
export async function mirrorSummarizing(firestore: Firestore, input: { noteId: string; workspaceId: string }): Promise<void> {
  // update(), never set(): a note deleted since the claim must not come back.
  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .update({ status: 'summarizing', updatedAt: ISO_NOW() });
}

/** Firestore's answer (gRPC NOT_FOUND) when update() targets a missing doc. */
function isFirestoreNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === 5 || e.code === 'not-found' || /\bNOT_FOUND\b/.test(String(e.message ?? '')));
}

export interface MarkSummaryReadyInput {
  noteId: string;
  workspaceId: string;
  summary: { gist: string; actionItems: string[]; keyDecisions: string[] };
  model?: string | null;
  /** Redacted transcript preview for the live UI (the full transcript stays in Postgres). */
  transcriptPreview: { speaker: string; text: string; time: string }[];
  transcriptTruncated: boolean;
  /**
   * The note's summary_generation when this run read it, before the Gemini
   * call. The write only lands if it is still current: a regenerate claimed
   * during the run bumps it, and the older run must not overwrite the newer one.
   */
  expectedGeneration: number;
}

export type MarkSummaryReadyResult =
  | { written: true }
  /** not_found: deleted or not in this workspace. superseded: a newer generation owns the note. */
  | { written: false; reason: 'not_found' | 'superseded' };

/**
 * The summarizer's final write (the last pipeline stage). In one transaction,
 * the note is marked 'ready' in the task's workspace, the manual-edit and
 * regenerate flags are cleared (they described the summary being replaced),
 * and the summary, action items and key decisions are replaced. Then the
 * Firestore mirror is written.
 *
 * Nothing is written, in either store, if the note is gone (deleted mid-run),
 * isn't in that workspace, or has moved on to a newer summary generation since
 * this run read it. Mirroring anyway would resurrect a phantom document, or put
 * a stale summary over a newer one. Idempotent on replay: everything is upserted
 * or replaced.
 */
export async function markSummaryReady(
  firestore: Firestore,
  input: MarkSummaryReadyInput,
  log: { error: (o: any, m?: string) => void },
): Promise<MarkSummaryReadyResult> {
  const outcome = await withTx(
    async (client): Promise<MarkSummaryReadyResult> => {
      const note = await client.query(
        `UPDATE notes
            SET status = 'ready',
                summary_manually_edited_at = NULL,
                summary_requested_at = NULL,
                updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
            AND summary_generation = $3
          RETURNING id`,
        [input.noteId, input.workspaceId, input.expectedGeneration],
      );
      if (!note.rowCount) {
        const live = await client.query(
          'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
          [input.noteId, input.workspaceId],
        );
        return { written: false, reason: live.rowCount ? 'superseded' : 'not_found' };
      }
      await client.query(
        `INSERT INTO summaries (note_id, gist, long_summary, topics, model)
           VALUES ($1, $2, NULL, $3, $4)
         ON CONFLICT (note_id) DO UPDATE
           SET gist = EXCLUDED.gist, topics = EXCLUDED.topics,
               model = EXCLUDED.model, generated_at = NOW()`,
        [input.noteId, input.summary.gist || '', JSON.stringify(input.summary.actionItems || []), input.model || null],
      );
      await client.query('DELETE FROM action_items WHERE note_id = $1', [input.noteId]);
      for (const text of input.summary.actionItems || []) {
        await client.query('INSERT INTO action_items (note_id, text) VALUES ($1, $2)', [input.noteId, text]);
      }
      await client.query('DELETE FROM key_decisions WHERE note_id = $1', [input.noteId]);
      for (const text of input.summary.keyDecisions || []) {
        await client.query('INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)', [input.noteId, text]);
      }
      return { written: true };
    },
    { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
  );
  if (!outcome.written) return outcome;

  // update(), never set(): if the note was deleted between the commit above
  // and here, set({ merge: true }) would re-create its doc (with the summary
  // and transcript preview). update() fails on the missing doc instead, and
  // the caller treats the note as gone (no "ready" push). The summary fields go
  // by field path, merged exactly as set({ merge: true }) merged them.
  try {
    await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update({
      status: 'ready',
      updatedAt: ISO_NOW(),
      'summary.gist': input.summary.gist || '',
      'summary.actionItems': input.summary.actionItems || [],
      'summary.keyDecisions': input.summary.keyDecisions || [],
      transcript: input.transcriptPreview,
      transcriptTruncated: input.transcriptTruncated,
    });
  } catch (err) {
    // The doc is gone. That means "deleted" only if Postgres agrees. Firestore
    // also answers NOT_FOUND for a wrong project or database, and then this
    // must fail loudly (retry, then dead-letter) instead of dropping the note.
    if (isFirestoreNotFound(err)) {
      const { rowCount } = await getPool().query(
        'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [input.noteId, input.workspaceId],
      );
      if (!rowCount) return { written: false, reason: 'not_found' };
    }
    throw err;
  }
  return { written: true };
}

/**
 * Persist a successful AI run. Postgres write happens first (when
 * enabled) so a failure leaves the Firestore note in 'processing' for
 * the UI rather than flipping to 'ready' against a stale DB.
 *
 * Returns whether the Postgres write was attempted.
 */
export async function markReady(
  firestore: Firestore,
  input: MarkReadyInput,
  log: { error: (o: any, m?: string) => void },
): Promise<{ pgWritten: boolean }> {
  let pgWritten = false;
  if (isPostgresEnabled()) {
    try {
      await upsertCoreToPostgres(input, log);
      pgWritten = true;
    } catch (err) {
      log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId }, 'pg_mark_ready_failed');
      // Postgres is the system of record (CLAUDE.md §1): never let the
      // Firestore cache say 'ready' for a note Postgres does not have. Fail
      // the call so the caller retries / marks the note errored instead.
      // (Previously this was swallowed and Firestore flipped to 'ready'
      // anyway, citing a "background reconciliation" that does not exist.)
      throw err;
    }
  }

  await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update({
    status: 'ready',
    summary: {
      gist: input.summary.gist || '',
      actionItems: input.summary.actionItems || [],
      keyDecisions: input.summary.keyDecisions || [],
    },
    transcript: input.transcript || [],
    errorMessage: FieldValue.delete(),
    updatedAt: ISO_NOW(),
  });
  return { pgWritten };
}

export async function markError(
  firestore: Firestore,
  input: MarkErrorInput,
  log: { error: (o: any, m?: string) => void },
): Promise<void> {
  if (isPostgresEnabled()) {
    try {
      await getPool().query(
        // Scoped to the caller's workspace: an id from another workspace
        // (e.g. after markReady rejected a cross-workspace write) matches nothing.
        `UPDATE notes SET status='error', error_message=$3, updated_at=NOW()
           WHERE id=$1 AND workspace_id=$2`,
        [input.noteId, input.workspaceId, input.errorMessage],
      );
    } catch (err) {
      log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId }, 'pg_mark_error_failed');
    }
  }
  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .update({ status: 'error', errorMessage: input.errorMessage, updatedAt: ISO_NOW() });
}

/**
 * Persist a manual note edit (title / summary) to Postgres (system of record)
 * and mirror it to Firestore. As in markReady, a Postgres failure is NOT
 * swallowed — the edit fails hard so the Firestore cache never leads the
 * record. The Postgres UPDATE is scoped to input.workspaceId. Only the fields provided are touched; a note without a Postgres
 * row yet (legacy / not-yet-processed) still gets the Firestore mirror.
 */
export async function applyNoteEdit(
  firestore: Firestore,
  input: ApplyNoteEditInput,
  log: { error: (o: any, m?: string) => void },
): Promise<{ pgWritten: boolean }> {
  let pgWritten = false;
  if (isPostgresEnabled()) {
    try {
      const { pgRowPresent } = await withTx((client) =>
        writeNoteEditWithinTx(client, {
          noteId: input.noteId,
          workspaceId: input.workspaceId,
          title: input.title,
          summary: input.summary,
        }),
      );
      pgWritten = pgRowPresent;
    } catch (err) {
      log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId }, 'pg_apply_note_edit_failed');
      throw err;
    }
  }

  const mirror: Record<string, unknown> = { updatedAt: ISO_NOW() };
  if (typeof input.title === 'string') mirror.title = input.title;
  if (input.summary) mirror.summary = input.summary;
  await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update(mirror);

  return { pgWritten };
}

export type DeleteNoteResult =
  /** The caller is not a member of the workspace: nothing was touched. */
  | { allowed: false }
  /** deleted: whether a Postgres row went (false on a retry, or a note that never reached Postgres). */
  | { allowed: true; deleted: boolean; purgeId: number };

/**
 * Delete a note (POST /v1/notes/delete). This is the single deletion path;
 * it replaces the undeployed functions/ onNoteDeleted trigger.
 *
 * Postgres first, in one transaction:
 *   - the caller must be the note's author, or an owner/admin of the
 *     workspace (a plain member or viewer can't delete someone else's note);
 *   - the note row is deleted, scoped to that workspace, and ON DELETE CASCADE
 *     removes its transcript, summary, action items, decisions, embeddings,
 *     chunks and shares, so search and chat can't return it;
 *   - its upload sessions go too, so an unfinished upload can't be completed
 *     into a deleted note;
 *   - a storage_purges row records what must go outside Postgres (the audio,
 *     and the mirror doc again), which the caller then runs (see
 *     storage-purges-repo). If the process dies before the Firestore delete
 *     below, the purge still removes the doc.
 * Then the Firestore mirror doc is deleted.
 *
 * Idempotent: on a retry after a partial failure the Postgres row is already
 * gone (deleted: false), but the Firestore delete and a purge still run, so the
 * retry finishes the job. A note that never reached Postgres (an upload that
 * was never processed) gets the same Firestore delete and purge.
 */
export async function deleteNote(
  firestore: Firestore,
  input: { noteId: string; workspaceId: string; uid: string; traceId?: string | null },
  log: { error: (o: any, m?: string) => void },
): Promise<DeleteNoteResult> {
  if (!isPostgresEnabled()) throw new Error('deleteNote needs Postgres (WRITE_POSTGRES=true)');
  const outcome = await withTx(
    async (client): Promise<DeleteNoteResult> => {
      // The kickoff's lock: a kickoff in flight commits first, and this then
      // deletes the row it wrote (markQueued re-checks for this deletion).
      await lockNoteId(client, input.noteId);
      const member = await client.query<{ role: string }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND uid = $2',
        [input.workspaceId, input.uid],
      );
      if (!member.rowCount) return { allowed: false };
      const manager = ['owner', 'admin'].includes(member.rows[0]!.role);
      const gone = await client.query<{ storage_path: string | null }>(
        `DELETE FROM notes WHERE id = $1 AND workspace_id = $2 AND ($3::boolean OR author_uid = $4)
         RETURNING storage_path`,
        [input.noteId, input.workspaceId, manager, input.uid],
      );
      const deleted = (gone.rowCount ?? 0) > 0;
      // Nothing deleted: either the note is someone else's and the caller
      // doesn't manage the workspace, or there's no Postgres row (a retry, or
      // a note never processed). Only a manager may clean up the latter, since
      // authorship can no longer be checked.
      if (!deleted) {
        const here = await client.query(
          'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2',
          [input.noteId, input.workspaceId],
        );
        if (here.rowCount || !manager) return { allowed: false };
      }
      // Their GCS session URIs stay valid for a week: the purge cancels them.
      const sessions = await client.query<{ session_uri: string }>(
        'DELETE FROM upload_sessions WHERE note_id = $1 AND workspace_id = $2 RETURNING session_uri',
        [input.noteId, input.workspaceId],
      );
      // The scratch prefix is keyed by note id alone. Purge it only if this
      // delete proves the id was this workspace's: its row went here, or no
      // workspace has a note with this id.
      const includeScratch = deleted
        || !(await client.query('SELECT 1 FROM notes WHERE id = $1', [input.noteId])).rowCount;
      const purge = await client.query<{ id: string }>(
        `INSERT INTO storage_purges (note_id, workspace_id, storage_path, include_scratch, trace_id, upload_session_uris)
           VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.noteId, input.workspaceId, gone.rows[0]?.storage_path ?? null, includeScratch, input.traceId ?? null,
          sessions.rows.map((r) => r.session_uri),
        ],
      );
      return { allowed: true, deleted, purgeId: Number(purge.rows[0]!.id) };
    },
    { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
  );
  if (!outcome.allowed) return outcome;

  // After the commit, and also when Postgres had nothing to delete, so a retry
  // after a failed mirror delete finishes it. Deleting a missing doc succeeds.
  await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).delete();
  return outcome;
}

/**
 * Notes older than their author's retention choice (users.retention_days; NULL
 * means keep until deleted), oldest first. The sweeper deletes them through
 * deleteNote, the same path as a manual delete (DATA-RETENTION §2).
 */
export async function listNotesPastRetention(
  input: { now?: Date; limit?: number } = {},
): Promise<Array<{ noteId: string; workspaceId: string; authorUid: string; createdAt: Date }>> {
  const { rows } = await getPool().query(
    `SELECT n.id, n.workspace_id, n.author_uid, n.created_at
       FROM notes n JOIN users u ON u.uid = n.author_uid
      WHERE u.retention_days IS NOT NULL AND n.deleted_at IS NULL
        AND n.created_at < $1::timestamptz - (u.retention_days * INTERVAL '1 day')
      ORDER BY n.created_at ASC LIMIT $2`,
    [(input.now ?? new Date()).toISOString(), input.limit ?? 200],
  );
  return rows.map((r) => ({
    noteId: r.id, workspaceId: r.workspace_id, authorUid: r.author_uid, createdAt: new Date(r.created_at),
  }));
}

/**
 * Notes stuck in an in-flight status (no progress written) for longer than
 * `olderThanMs`, oldest first: what the sweeper fails, so the user sees an
 * error and can retry instead of a spinner that never ends. The threshold
 * must exceed IN_FLIGHT_STALE_MS, so a client re-queue gets its chance first.
 */
export async function listStuckNotes(
  input: { olderThanMs: number; limit?: number },
): Promise<Array<{ noteId: string; workspaceId: string; authorUid: string; status: string; updatedAt: Date }>> {
  const { rows } = await getPool().query(
    `SELECT id, workspace_id, author_uid, status, updated_at FROM notes
      WHERE status = ANY($1::text[]) AND deleted_at IS NULL
        AND updated_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')
      ORDER BY updated_at ASC LIMIT $3`,
    [IN_FLIGHT_STATUSES as unknown as string[], input.olderThanMs, input.limit ?? 100],
  );
  return rows.map((r) => ({
    noteId: r.id, workspaceId: r.workspace_id, authorUid: r.author_uid, status: r.status, updatedAt: new Date(r.updated_at),
  }));
}

/**
 * Fail a note the sweeper found stuck, only if it is STILL stuck. The UPDATE
 * repeats the selection condition (in flight, unchanged for olderThanMs, same
 * workspace, not deleted), so a note that moved on since the listing (a chunk
 * finished, it became ready, the client re-queued it, it was deleted) is left
 * alone. The mirror, and the caller's dead letter and refund, happen only when
 * a row matched. Postgres first; the mirror uses update(), so a deleted note's
 * doc is never re-created.
 */
export async function failStuckNote(
  firestore: Firestore,
  input: { noteId: string; workspaceId: string; olderThanMs: number; message: string },
  log: { error: (o: any, m?: string) => void },
): Promise<{ failed: boolean }> {
  const { rowCount } = await getPool().query(
    `UPDATE notes SET status = 'error', error_message = $3, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        AND status = ANY($4::text[])
        AND updated_at < NOW() - ($5::bigint * INTERVAL '1 millisecond')`,
    [input.noteId, input.workspaceId, input.message, IN_FLIGHT_STATUSES as unknown as string[], input.olderThanMs],
  );
  if (!rowCount) return { failed: false };
  try {
    await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update({
      status: 'error', errorMessage: input.message, updatedAt: ISO_NOW(),
    });
  } catch (err) {
    // Postgres (the source of truth) has it; the doc may be gone (deleted
    // note) or briefly unavailable. The next read path reconciles from Postgres.
    log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId }, 'stuck_note_mirror_failed');
  }
  return { failed: true };
}
