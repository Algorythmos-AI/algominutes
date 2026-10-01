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
import { randomUUID } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { getPool, isPostgresEnabled, withTx } from './db';
import { ensureUser, ensureWorkspaceAccess, WorkspaceBoundaryError } from './workspace-access';
import { insertDebit } from './ledger';
import { resolveEntitlement, QuotaExceededError } from './entitlements';
import ledgerReversal from '@algominutes/db/ledger-reversal.cjs';

// The one copy of the refund SQL, written in a failure's own transaction.
const { reverseNoteUsage } = ledgerReversal as {
  reverseNoteUsage: (
    queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    input: { noteId: string; reason: string; idempotencyKey: string },
  ) => Promise<{ applied: boolean; minutesReversed: number }>;
};
import { lockNoteId } from './note-lock';
import { isNoteDeleted, recordNoteDeleted } from './deleted-notes-repo';
import { advanceBotStatus, botFromRow, enqueueRecallPurge, purgeRecallBotsOf, toNotetakerStatus, BOT_STATUS_RANK, type BotStatus, type MeetingBot } from './meetings-repo';
import noteStorage from '@algominutes/ai/note-storage.cjs';

const { ownedStoragePath } = noteStorage as {
  ownedStoragePath: (storagePath: string | null, workspaceId: string, noteId: string) => string | null;
};
// Shared, Postgres-only edit writer (the api's update-note route uses it too),
// so the edit SQL lives in one place. Imported as a default (CJS) — see
// server.ts for the same pattern.
import noteEditShared from '@algominutes/db/note-edit.cjs';
import noteNoticesShared from '@algominutes/db/note-notices.cjs';
import notifyShared from '@algominutes/ai/notify.cjs';

/** A "ready" or "failed" notice (note-notices.cjs, migration 022). */
export interface NoteNotice {
  id: string;
  noteId: string;
  workspaceId: string;
  uid: string;
  kind: 'note_ready' | 'note_failed';
  traceId: string | null;
}
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const { recordNotice } = noteNoticesShared as {
  recordNotice: (
    queryable: Queryable,
    input: { noteId: string; workspaceId: string; kind: NoteNotice['kind']; traceId?: string | null },
  ) => Promise<NoteNotice | null>;
};
const { enqueueNotice } = notifyShared as {
  enqueueNotice: (args: { notice: NoteNotice; traceId: string; log: any }) => Promise<'enqueued' | 'skipped' | 'failed'>;
};

/** Enqueue a notice written by a commit that just happened (never throws). */
async function tellAuthor(notice: NoteNotice | null, traceId: string, log: any): Promise<void> {
  if (!notice) return;
  await enqueueNotice({ notice, traceId, log });
}
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
   *
   * `enforceQuota`: check the user's minutes in the same transaction, right
   * before the debit, and throw QuotaExceededError (nothing written) if it
   * wouldn't fit. The notetaker's ingest passes false: its minutes were
   * reserved when the bot was sent.
   */
  meter?: { minutes: number; idempotencyKey: string; enforceQuota?: boolean };
  /**
   * A held note's resume (held-notes.ts): queue it only if it's still held,
   * checked under the note's lock. The sweep works from a list, and a client may
   * have run the note since (finished, or failed and refunded): that run stands.
   */
  onlyIfHeld?: boolean;
  /**
   * Over the minutes left, hold the note instead of refusing it (RELEASE.md rev
   * 11, H6c): the same transaction leaves it 'awaiting_minutes', uncharged, and
   * returns `held` (mirrored as such). For an uploaded recording, whose audio is
   * already ours; the resume queues it once minutes arrive (held-notes.ts).
   */
  holdIfOverQuota?: boolean;
  /**
   * A note still 'recording' (a notetaker in its meeting) is queued only by the
   * notetaker's own ingest, which ends the recording. Checked under the note's
   * lock, so a client kickoff can never race it.
   */
  allowRecording?: boolean;
  /**
   * The notetaker's ingest: its bot. Its note's run is queued once: a bot whose
   * run was already queued is answered `alreadyQueued` (an ingest replayed after
   * the run has finished must not run it again), and queuing stamps
   * meeting_bots.run_queued_at in this transaction. markError's
   * `reopenMeetingBotId` clears it when the kickoff itself fails.
   */
  meetingBotId?: string;
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

/**
 * How many of the user's notes are being processed right now (in flight, and not stale): the kickoff lets a
 * user have at most MAX_IN_FLIGHT_PER_USER at once (RELEASE.md rev 11, L7).
 */
export async function countInFlightNotesForUser(uid: string, now: Date = new Date()): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notes
      WHERE author_uid = $1 AND deleted_at IS NULL
        AND status = ANY($2::text[])
        AND updated_at > $3::timestamptz - $4::bigint * INTERVAL '1 millisecond'`,
    [uid, IN_FLIGHT_STATUSES as unknown as string[], now, IN_FLIGHT_STALE_MS],
  );
  return rows[0]?.n ?? 0;
}

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
): Promise<{ queued: boolean; status: string | null; deleted?: true; runSeq?: number; alreadyQueued?: true; held?: true }> {
  const noteDoc = firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`);
  let runSeq: number | undefined;
  if (isPostgresEnabled()) {
    const outcome = await withTx(
      async (client): Promise<{ queued: boolean; status: string | null; deleted?: true; runSeq?: number; alreadyQueued?: true; held?: true }> => {
        // Serialize kickoffs for this note id, including a brand-new note with
        // no row to lock yet: the second of two concurrent duplicates waits
        // here, then sees the first's 'queued' row and backs off. deleteNote
        // takes the same lock, so a deletion either committed before this
        // point or waits until this transaction ends.
        await lockNoteId(client, input.noteId);
        // No row: a note never queued, or one deleted since the route read its
        // doc. A deletion leaves a purge row until the doc and the audio are
        // gone, then a tombstone (and the doc is missing, unless a stale client
        // wrote it again). Either way it stays deleted: the INSERT below would
        // bring the row back. Checked before any row lock, so the Firestore
        // read holds only the note lock. (A row can't vanish meanwhile:
        // deleteNote waits for that lock.)
        const hasRow = await client.query('SELECT 1 FROM notes WHERE id = $1', [input.noteId]);
        if (!hasRow.rowCount) {
          if (await isNoteDeleted(client, input) || !(await noteDoc.get()).exists) {
            return { queued: false, status: null, deleted: true };
          }
        }
        // The user row first, then the note row: the same order account
        // deletion takes them (users FOR UPDATE, then the cascade to notes), so
        // the two can't deadlock. It also refuses a deleted account.
        await ensureUser(client, { uid: input.authorUid, email: input.authorEmail, name: input.authorName });
        if (input.meetingBotId) {
          // Users, then the bot, then the note: account deletion takes the user
          // first and failNotetaker the bot before the note. (createServerNote
          // takes the bot before the user, but holds this note's lock, as this
          // does.) A bot no longer linked to this note had it deleted (note_id
          // goes NULL), or went with its account.
          const { rows: [bot] } = await client.query(
            'SELECT note_id, run_queued_at FROM meeting_bots WHERE id = $1 FOR UPDATE',
            [input.meetingBotId],
          );
          if (!bot || bot.note_id !== input.noteId) return { queued: false, status: null, deleted: true };
          if (bot.run_queued_at) return { queued: false, status: null, alreadyQueued: true };
        }
        const existing = await client.query(
          'SELECT workspace_id, status, updated_at FROM notes WHERE id = $1 FOR UPDATE',
          [input.noteId],
        );
        const state = queueStateOf(existing.rows[0], input.workspaceId, now);
        if (state.foreign) {
          throw new WorkspaceBoundaryError(`note ${input.noteId} belongs to a different workspace`);
        }
        if (state.status === 'recording' && !input.allowRecording) {
          return { queued: false, status: 'recording' };
        }
        if (state.inFlight) {
          // Idempotent: a duplicate kickoff (e.g. a client retry after a
          // timeout) must not reset the running job or delete its chunks.
          return { queued: false, status: state.status };
        }
        if (input.onlyIfHeld && state.status !== 'awaiting_minutes') {
          return { queued: false, status: state.status };
        }
        if (state.status === 'ready') {
          // A finished note is never queued again (kickoff.ts): its transcript and summary stand.
          return { queued: false, status: 'ready' };
        }

        await ensureWorkspaceAccess(
          client,
          input.workspaceId,
          input.authorUid,
          input.authorName ? `${input.authorName}'s Workspace` : 'My Workspace',
        );
        const noteRow = await client.query(
          `INSERT INTO notes (id, workspace_id, author_uid, status, source_type, storage_path, source_url, mime_type, queued_at)
             VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, NOW())
           ON CONFLICT (id) DO UPDATE SET
             status = 'queued',
             -- This run's start, for SLO 4 (the summarizer times the run from it; migration 026).
             queued_at = NOW(),
             source_type = EXCLUDED.source_type,
             storage_path = COALESCE(EXCLUDED.storage_path, notes.storage_path),
             source_url   = COALESCE(EXCLUDED.source_url, notes.source_url),
             mime_type    = COALESCE(EXCLUDED.mime_type, notes.mime_type),
             summarizer_enqueued_at = NULL,
             embedder_enqueued_at = NULL,
             -- A new run: its outcome gets its own notice (note-notices.cjs),
             -- and it isn't a regeneration, whatever an earlier one left set.
             run_seq = notes.run_seq + 1,
             summary_requested_at = NULL,
             chunks_done = 0,
             chunks_total = NULL,
             duration_sec_probed = NULL,
             error_message = NULL,
             updated_at = NOW()
           -- An existing note id in ANOTHER workspace must never be touched.
           WHERE notes.workspace_id = EXCLUDED.workspace_id
           RETURNING id, run_seq`,
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
        // A new run re-transcribes from scratch, so the last run's lines go with
        // its chunks: they'd otherwise survive with chunk_id NULL (ON DELETE SET
        // NULL), which the (chunk_id, idx) upsert never matches, and a Try again
        // would double the transcript, the summary and the embeddings (rev 11 L3).
        await client.query('DELETE FROM transcript_lines WHERE note_id = $1', [input.noteId]);
        await client.query('DELETE FROM audio_chunks WHERE note_id = $1', [input.noteId]);
        if (input.meetingBotId) {
          await client.query('UPDATE meeting_bots SET run_queued_at = NOW(), updated_at = NOW() WHERE id = $1', [input.meetingBotId]);
        }
        if (input.meter) {
          // One debit per run, decided under this note's row lock, which a
          // failure also holds while it writes its refund (ledger-reversal.cjs):
          // the ledger read here sees both or neither. A note whose
          // last run was refunded (net 0) is charged again: its re-run is real
          // work, and a per-note key made it free. One whose charge still
          // stands (a failure that wasn't refunded) isn't charged twice.
          const { rows: [led] } = await client.query(
            `SELECT COALESCE(SUM(minutes), 0)::float8 AS net,
                    COUNT(*) FILTER (WHERE entry_type = 'debit')::int AS debits
               FROM usage_ledger WHERE note_id = $1`,
            [input.noteId],
          );
          if (Number(led.net) <= 0) {
            if (input.meter.enforceQuota) {
              // The quota check and the debit it guards, in one transaction under
              // a per-user lock: two kickoffs of different notes can't both see
              // the same headroom and both debit it. (ensureUser's upsert above
              // also locks the user's row; this lock doesn't depend on that.)
              // A run whose charge still stands never gets here, so its retry
              // needs no headroom.
              await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`meter:${input.authorUid}`]);
              const ent = await resolveEntitlement(input.authorUid, { db: client });
              if (ent.includedMinutes != null && ent.usedMinutes + input.meter.minutes > ent.includedMinutes) {
                // Never a notetaker's run: its bot was stamped queued above, and a held run it would never leave.
                if (input.holdIfOverQuota && !input.meetingBotId) {
                  // The row this call just wrote, in its workspace: held, and nothing debited.
                  await client.query(
                    `UPDATE notes SET status = 'awaiting_minutes', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
                    [input.noteId, input.workspaceId],
                  );
                  return { queued: false, held: true, status: 'awaiting_minutes' };
                }
                throw new QuotaExceededError(ent, input.meter.minutes);
              }
            }
            const idempotencyKey = led.debits === 0 ? input.meter.idempotencyKey : `${input.meter.idempotencyKey}:${led.debits}`;
            const debit = await insertDebit(client, {
              uid: input.authorUid,
              workspaceId: input.workspaceId,
              noteId: input.noteId,
              minutes: input.meter.minutes,
              reason: 'ingest',
              idempotencyKey,
            });
            // The count reads rows still linked to this note; a deleted note's
            // rows aren't (note_id goes NULL), so a re-used note id can meet its
            // old key and run free. Not expected; say so if it happens.
            if (!debit.applied) {
              log.error({ noteId: input.noteId, workspaceId: input.workspaceId, userId: input.authorUid, idempotencyKey }, 'meter_debit_key_taken');
            }
          }
        }
        // The run this queues: its kickoff task carries it, and a task from an earlier run is dropped (audit Q12).
        return { queued: true, status: 'queued', runSeq: Number(noteRow.rows[0].run_seq) };
      },
      { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
    );
    if (outcome.held) {
      // update(), never a merge-set, as below. Held is safe to leave half-mirrored: the sweep's mirror repair
      // covers 'awaiting_minutes', so a failed write is logged, never turned into a failed note.
      try {
        await noteDoc.update({ status: 'awaiting_minutes', errorMessage: null, updatedAt: ISO_NOW() });
      } catch (err) {
        log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId, userId: input.authorUid }, isFirestoreNotFound(err) ? 'held_note_doc_missing' : 'held_note_mirror_failed');
      }
      return outcome;
    }
    if (!outcome.queued) return outcome;
    runSeq = outcome.runSeq;
  }

  // update(), never a merge-set: a doc deleted after the commit above must not
  // be re-created.
  try {
    await noteDoc.update({ status: 'queued', updatedAt: ISO_NOW() });
  } catch (err) {
    // silent-catch-ok: NOT_FOUND with no Postgres row is a deleted note, answered as deleted: true
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
      // `committed`: Postgres queued it (and a notetaker's bot is stamped), so
      // the caller's failure has to undo that; a throw from the transaction
      // itself wrote nothing.
      if (live.rowCount) throw Object.assign(err as object, { committed: true });
    }
    return { queued: false, status: null, deleted: true };
  }
  return { queued: true, status: 'queued', ...(runSeq !== undefined ? { runSeq } : {}) };
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
            summary_requested_at = NULL,
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
  summary: {
    gist: string;
    actionItems: string[];
    keyDecisions: string[];
    /** Validated sections (summary-output.cjs normalizeChapters); none for a short note. */
    chapters?: Array<{ startMs: number; title: string; summary: string }>;
  };
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
  /** The recording's, for the "ready" notice's task. */
  traceId?: string | null;
}

export type MarkSummaryReadyResult =
  /** notice: the "ready" notice this write recorded (none on a replay of the same outcome). */
  | { written: true; notice?: NoteNotice | null }
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
 *
 * The "ready" notice is written in the same transaction and enqueued right
 * after the commit, before the mirror, so a mirror failure can't hold back the
 * push (note-notices.cjs). A replay of the same summary writes no second one.
 */
export async function markSummaryReady(
  firestore: Firestore,
  input: MarkSummaryReadyInput,
  log: { error: (o: any, m?: string) => void },
): Promise<MarkSummaryReadyResult> {
  // The recording's traceId for the notice row and its task (minted only if
  // the caller had none, before the write, so both agree).
  const trace = input.traceId || randomUUID();
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
        `INSERT INTO summaries (note_id, gist, long_summary, topics, model, chapters)
           VALUES ($1, $2, NULL, $3, $4, $5)
         ON CONFLICT (note_id) DO UPDATE
           SET gist = EXCLUDED.gist, topics = EXCLUDED.topics,
               model = EXCLUDED.model, chapters = EXCLUDED.chapters, generated_at = NOW()`,
        [
          input.noteId, input.summary.gist || '', JSON.stringify(input.summary.actionItems || []), input.model || null,
          JSON.stringify(input.summary.chapters || []),
        ],
      );
      await client.query('DELETE FROM action_items WHERE note_id = $1', [input.noteId]);
      for (const text of input.summary.actionItems || []) {
        await client.query('INSERT INTO action_items (note_id, text) VALUES ($1, $2)', [input.noteId, text]);
      }
      await client.query('DELETE FROM key_decisions WHERE note_id = $1', [input.noteId]);
      for (const text of input.summary.keyDecisions || []) {
        await client.query('INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)', [input.noteId, text]);
      }
      const notice = await recordNotice(client, {
        noteId: input.noteId, workspaceId: input.workspaceId, kind: 'note_ready', traceId: trace,
      });
      return { written: true, notice };
    },
    { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
  );
  if (!outcome.written) return outcome;
  await tellAuthor(outcome.notice ?? null, trace, log);

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
      // Replaced with the summary: a regenerate of a short note clears old chapters.
      'summary.chapters': input.summary.chapters || [],
      transcript: input.transcriptPreview,
      transcriptTruncated: input.transcriptTruncated,
    });
  } catch (err) {
    // silent-catch-ok: NOT_FOUND with no live Postgres row is a deleted note, answered as written: false
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
  return { written: true, notice: outcome.notice ?? null };
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

/**
 * Mark a note `error`: Postgres (with the refund, if any), then the Firestore
 * mirror. As in markReady, a Postgres failure is NOT swallowed: it is logged
 * and rethrown before the mirror, so the Firestore cache never says `error`
 * for a note Postgres still has in another state. A note with no Postgres row
 * yet matches nothing and gets the mirror only.
 */
export async function markError(
  firestore: Firestore,
  input: MarkErrorInput & {
    /** Written in the same transaction, under the note's row lock (ledger-reversal.cjs). */
    refund?: { reason: string; idempotencyKey: string };
    traceId?: string | null;
    /** A notetaker kickoff that failed after queuing: its bot's run is open again, so the retry queues it. */
    reopenMeetingBotId?: string;
  },
  log: { error: (o: any, m?: string) => void },
): Promise<void> {
  if (isPostgresEnabled()) {
    const fields = { noteId: input.noteId, workspaceId: input.workspaceId, traceId: input.traceId ?? undefined };
    try {
      await withTx(async (client) => {
        if (input.reopenMeetingBotId) {
          // The bot's row before the note's, as failNotetaker takes them.
          await client.query(
            'UPDATE meeting_bots SET run_queued_at = NULL, updated_at = NOW() WHERE id = $1 AND note_id = $2',
            [input.reopenMeetingBotId, input.noteId],
          );
        }
        const { rowCount } = await client.query(
          // Scoped to the caller's workspace: an id from another workspace
          // (e.g. after markReady rejected a cross-workspace write) matches nothing.
          `UPDATE notes SET status='error', error_message=$3, updated_at=NOW()
             WHERE id=$1 AND workspace_id=$2`,
          [input.noteId, input.workspaceId, input.errorMessage],
        );
        if (rowCount && input.refund) {
          await reverseNoteUsage(client, { noteId: input.noteId, ...input.refund });
        }
      }, { log, fields });
    } catch (err) {
      log.error({ err, ...fields }, 'pg_mark_error_failed');
      // Postgres is the system of record (CLAUDE.md §1): never mirror 'error'
      // for a note Postgres did not mark. (Previously this was swallowed and
      // Firestore flipped to 'error' anyway, and the caller returned normally.)
      throw err;
    }
  }
  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .update({ status: 'error', errorMessage: input.errorMessage, updatedAt: ISO_NOW() });
}

/**
 * A kickoff refused before it queued (too large, too long, over the rate limit
 * or the daily spend cap): the note is marked `error`, Postgres then the
 * mirror, unless it is in flight. Two duplicate kickoffs (a client retry after
 * a timeout) can both pass the route's pre-check; if one queues the note and
 * the other is then refused, the refusal must not fail the run the first one
 * started. A STALE in-flight note (a client retry after IN_FLIGHT_STALE_MS) is
 * left alone too: its run was charged, and marking it `error` here, with no
 * refund, would take it out of the stuck-note sweep that fails and refunds it.
 * The guard is in the UPDATE's own WHERE, so it is re-checked against a
 * duplicate's just-committed row. A note with no Postgres row yet gets the
 * mirror only, as markError does. Returns whether the note was marked.
 *
 * A note held for minutes is left alone too (RELEASE.md rev 11, H6): a retry
 * refused for the rate limit or the spend cap mustn't turn a recording waiting
 * for minutes into a failure the resume never picks up (found by
 * dual-write-auditor).
 */
export async function markKickoffRejected(
  firestore: Firestore,
  input: MarkErrorInput,
  log: { error: (o: any, m?: string) => void },
): Promise<{ marked: boolean }> {
  if (isPostgresEnabled()) {
    const { rows } = await getPool().query<{ updated: number; present: number }>(
      `WITH upd AS (
         UPDATE notes SET status = 'error', error_message = $3, updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2
            AND NOT (status = ANY($4::text[]))
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM upd)::int AS updated,
              (SELECT count(*) FROM notes WHERE id = $1 AND workspace_id = $2)::int AS present`,
      [input.noteId, input.workspaceId, input.errorMessage, [...IN_FLIGHT_STATUSES, 'awaiting_minutes']],
    );
    const { updated, present } = rows[0]!;
    if (present && !updated) return { marked: false };
  }
  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .update({ status: 'error', errorMessage: input.errorMessage, updatedAt: ISO_NOW() });
  return { marked: true };
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
  // Field paths, not the map: an edit carries the gist, action items and
  // decisions (and key points, if sent). Replacing `summary` whole dropped
  // `summary.chapters`, so editing one action item removed a long
  // recording's chapters from the app.
  if (input.summary) {
    // Only the fields an edit carries: a caller that skipped sanitizeNoteEdit
    // can't write any other `summary.*` path.
    for (const k of ['gist', 'actionItems', 'keyDecisions', 'keyPoints'] as const) {
      const v = input.summary[k];
      if (v !== undefined) mirror[`summary.${k}`] = v;
    }
  }
  await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update(mirror);

  return { pgWritten };
}

export type DeleteNoteResult =
  /** The caller is not a member of the workspace: nothing was touched. */
  | { allowed: false }
  /**
   * deleted: whether a Postgres row went (false on a retry, or a note that never reached Postgres).
   * recallPurges: a notetaker's Recall copies queued for deletion (and a live bot for leaving) with it.
   */
  | { allowed: true; deleted: boolean; purgeId: number; recallPurges: number };

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
      // A notetaker's note: its bot must remember the deletion, because the
      // row's delete sets meeting_bots.note_id to NULL and the tombstones are
      // pruned in 30 days (createServerNote checks note_deleted_at). Recall's
      // copy goes too, and a bot still in the meeting leaves it.
      const bots = await client.query<{ id: string; recall_bot_id: string | null; status: string; status_rank: number; trace_id: string | null }>(
        `SELECT id, recall_bot_id, status, status_rank, trace_id FROM meeting_bots
          WHERE note_id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.noteId, input.workspaceId],
      );
      const gone = await client.query<{ storage_path: string | null }>(
        `DELETE FROM notes WHERE id = $1 AND workspace_id = $2 AND ($3::boolean OR author_uid = $4)
         RETURNING storage_path`,
        [input.noteId, input.workspaceId, manager, input.uid],
      );
      const deleted = (gone.rowCount ?? 0) > 0;
      let recallPurges = 0;
      if (deleted && bots.rowCount) {
        await client.query(
          'UPDATE meeting_bots SET note_deleted_at = COALESCE(note_deleted_at, NOW()), updated_at = NOW() WHERE id = ANY($1::uuid[])',
          [bots.rows.map((b) => b.id)],
        );
        recallPurges = await purgeRecallBotsOf(client, bots.rows, 'note_deleted');
      }
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
      // Outlives the purge row, so a stale client can't upload into (or
      // re-queue) the note once the purge is done.
      await recordNoteDeleted(client, { noteId: input.noteId, workspaceId: input.workspaceId });
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
      return { allowed: true, deleted, purgeId: Number(purge.rows[0]!.id), recallPurges };
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
 * The object to sign for playback (POST /v1/notes/audio-url): the note's
 * storage_path, only for a live note in a workspace the caller belongs to
 * (CLAUDE.md §1), and only if it names this note's own object (storage_path
 * came from the client and is only prefix-checked). Null otherwise.
 */
export async function getNoteAudioPath(
  input: { noteId: string; workspaceId: string; uid: string },
): Promise<string | null> {
  const { rows } = await getPool().query<{ storage_path: string | null }>(
    `SELECT n.storage_path FROM notes n
       JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.uid = $3
      WHERE n.id = $1 AND n.workspace_id = $2 AND n.deleted_at IS NULL`,
    [input.noteId, input.workspaceId, input.uid],
  );
  return ownedStoragePath(rows[0]?.storage_path ?? null, input.workspaceId, input.noteId);
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
 * alone. With `refund`, the reversal is written in the same transaction, and so
 * is the "failed" notice, which is enqueued after the commit: the author is told
 * (note-notices.cjs).
 *
 * A stuck REGENERATION (`summarizing` under a regeneration's claim:
 * summary_requested_at set) is failed and told, but not refunded: the recording
 * was transcribed and summarised once, and that charge stands, as when the
 * summarizer's own last attempt fails one (`regeneration` in the result). The mirror, and the caller's dead letter, happen only when
 * a row matched. Postgres first; the mirror uses update(), so a deleted note's
 * doc is never re-created.
 */
export async function failStuckNote(
  firestore: Firestore,
  input: {
    noteId: string; workspaceId: string; olderThanMs: number; message: string;
    /** Written in the failure's transaction (ledger-reversal.cjs), under its row lock. */
    refund?: { reason: string; idempotencyKey: string };
    /** The sweep run's, for the "failed" notice's task. */
    traceId?: string | null;
  },
  log: { error: (o: any, m?: string) => void },
): Promise<{ failed: boolean; refunded?: boolean; regeneration?: boolean; notice?: NoteNotice | null }> {
  const trace = input.traceId || randomUUID();
  const { failed, refunded, regeneration, notice } = await withTx(async (client) => {
    // `p` reads, locked, what the UPDATE replaces: whether this is a
    // regeneration is decided on the row it fails.
    const { rows: [row] } = await client.query(
      `WITH p AS (
         SELECT id, (status = 'summarizing' AND summary_requested_at IS NOT NULL) AS regeneration
           FROM notes WHERE id = $1 AND workspace_id = $2 FOR NO KEY UPDATE
       )
       UPDATE notes n SET status = 'error', error_message = $3, updated_at = NOW()
         FROM p
        WHERE n.id = p.id AND n.deleted_at IS NULL
          AND n.status = ANY($4::text[])
          AND n.updated_at < NOW() - ($5::bigint * INTERVAL '1 millisecond')
        RETURNING p.regeneration`,
      [input.noteId, input.workspaceId, input.message, IN_FLIGHT_STATUSES as unknown as string[], input.olderThanMs],
    );
    if (!row) return { failed: false, refunded: false, regeneration: false, notice: null };
    const r = input.refund && !row.regeneration
      ? await reverseNoteUsage(client, { noteId: input.noteId, ...input.refund })
      : { applied: false };
    const written = await recordNotice(client, {
      noteId: input.noteId, workspaceId: input.workspaceId, kind: 'note_failed', traceId: trace,
    });
    return { failed: true, refunded: r.applied, regeneration: Boolean(row.regeneration), notice: written };
  }, { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } });
  if (!failed) return { failed: false };
  await tellAuthor(notice ?? null, trace, log);
  try {
    await firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`).update({
      status: 'error', errorMessage: input.message, updatedAt: ISO_NOW(),
    });
  } catch (err) {
    // Postgres (the source of truth) has it; the doc may be gone (deleted
    // note) or briefly unavailable. The next read path reconciles from Postgres.
    log.error({ err, noteId: input.noteId, workspaceId: input.workspaceId }, 'stuck_note_mirror_failed');
  }
  return { failed: true, refunded, regeneration, notice };
}

// ── Server-created notes (the online-meeting notetaker, docs/plans/MEETINGS.md) ──

export interface CreateServerNoteInput {
  /** The bot whose recording this note is. The note's id is noteIdForBot(botId). */
  botId: string;
  noteId: string;
  workspaceId: string;
  uid: string;
  email?: string | null;
  name?: string | null;
  title: string;
  /** An existing NoteType, so every client already accepts the note. */
  sourceType: 'online_meeting';
  sourceKind: 'bot';
  platform: string;
  /** The Firestore mirror's notetaker field (NoteNotetaker). */
  notetaker: { botId: string; status: string; platform: string };
  meetingAt?: Date | null;
}

function isFirestoreAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === 6 || e.code === 'already-exists' || /\bALREADY_EXISTS\b/.test(String(e.message ?? '')));
}

/**
 * Create the note a notetaker's recording becomes, which no client wrote first.
 *
 * Postgres first, under the note lock: the bot must exist, belong to this user
 * and workspace, and not have had its note deleted (meeting_bots.note_deleted_at,
 * which outlives the deletion tombstones, so a task replayed weeks later can't
 * bring it back). The row is created in 'recording' and linked to the bot in
 * the same transaction. Then the Firestore mirror doc, with the fields a
 * client's own note has (status 'recording', type 'online_meeting': values
 * every build in the field accepts), created only if absent.
 *
 * Safe to repeat, and meant to be: the api calls it on every attempt of a
 * notetaker request, before it queues create_bot (so no bot is sent without
 * its note), which also writes a mirror doc a failed earlier attempt left
 * missing. (Ingest doesn't call it: a notetaker note whose doc went missing
 * is left to the reconcile, RELEASE.md PR 21.)
 * A note deleted meanwhile never keeps a doc: on 'deleted' the doc is removed,
 * and a failure to remove it throws, so the task retries.
 */
export async function createServerNote(
  firestore: Firestore,
  input: CreateServerNoteInput,
  log: { error: (o: any, m?: string) => void },
): Promise<{ created: boolean; deleted?: true }> {
  if (!isPostgresEnabled()) throw new Error('createServerNote: Postgres is not enabled');
  const fields = { noteId: input.noteId, workspaceId: input.workspaceId, userId: input.uid };
  const noteDoc = firestore.doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`);
  const outcome = await withTx(async (client): Promise<{ created: boolean; deleted?: true }> => {
    await lockNoteId(client, input.noteId);
    const { rows: [bot] } = await client.query(
      'SELECT uid, workspace_id, note_id, note_deleted_at FROM meeting_bots WHERE id = $1 FOR UPDATE',
      [input.botId],
    );
    // No bot: its account was deleted (the rows cascade). Nothing to create.
    if (!bot) return { created: false, deleted: true };
    if (bot.uid !== input.uid || bot.workspace_id !== input.workspaceId || (bot.note_id && bot.note_id !== input.noteId)) {
      throw new WorkspaceBoundaryError(`bot ${input.botId} is not ${input.uid}'s in ${input.workspaceId}`);
    }
    if (bot.note_deleted_at) return { created: false, deleted: true };

    const existing = await client.query('SELECT workspace_id FROM notes WHERE id = $1', [input.noteId]);
    let created = false;
    if (existing.rowCount) {
      if (existing.rows[0].workspace_id !== input.workspaceId) {
        throw new WorkspaceBoundaryError(`note ${input.noteId} belongs to a different workspace`);
      }
    } else {
      if (await isNoteDeleted(client, input)) return { created: false, deleted: true };
      // The user row, then the workspace, then the note: the order account
      // deletion locks them in. ensureUser also refuses a deleted account.
      await ensureUser(client, { uid: input.uid, email: input.email, name: input.name });
      await ensureWorkspaceAccess(client, input.workspaceId, input.uid, input.name ? `${input.name}'s Workspace` : 'My Workspace');
      await client.query(
        `INSERT INTO notes (id, workspace_id, author_uid, title, status, source_type, source_kind, platform, meeting_at)
           VALUES ($1, $2, $3, $4, 'recording', $5, $6, $7, $8)`,
        [input.noteId, input.workspaceId, input.uid, input.title, input.sourceType, input.sourceKind, input.platform, input.meetingAt ?? null],
      );
      created = true;
    }
    await client.query(
      'UPDATE meeting_bots SET note_id = $2, updated_at = NOW() WHERE id = $1 AND (note_id IS NULL OR note_id = $2)',
      [input.botId, input.noteId],
    );
    return { created };
  }, { log, fields });

  if (outcome.deleted) {
    // A doc left by an earlier attempt goes too. Deleting a missing doc succeeds.
    await noteDoc.delete();
    return outcome;
  }
  const now = ISO_NOW();
  try {
    await noteDoc.create({
      title: input.title,
      workspaceId: input.workspaceId,
      authorId: input.uid,
      status: 'recording',
      type: input.sourceType,
      sourceKind: input.sourceKind,
      notetaker: { ...input.notetaker, rank: 0 },
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // silent-catch-ok: ALREADY_EXISTS is a replayed task finding the doc it already created
    if (!isFirestoreAlreadyExists(err)) throw err;
  }
  // Deleted between the commit and the write? Then the doc is an orphan: take it
  // back out (a failure throws, so the task retries).
  const live = await getPool().query('SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2', [input.noteId, input.workspaceId]);
  if (!live.rowCount) {
    await noteDoc.delete();
    return { created: false, deleted: true };
  }
  return { created: outcome.created };
}

/**
 * A notetaker that ended without a recording (docs/plans/MEETINGS.md). In one
 * transaction, under the bot's row lock:
 *   - the bot becomes terminal, unless it already is (then its own status and
 *     reason stand: the first ending wins, and every writer writes the same);
 *   - its note fails with the words for that ending, only while the note is
 *     still 'recording' (a note that went on to be processed never fails here);
 *   - Recall's copy of anything it captured is queued for deletion, asking the
 *     bot to leave first if it may still be in the call.
 * Nothing is charged: a notetaker's minutes are only charged at ingest, and a
 * bot that ended without a recording releases its reservation.
 * Then the mirror, rebuilt from what Postgres now says. Safe to run again, and
 * meant to be: a task that finds a failed bot runs this to finish a mirror an
 * earlier attempt couldn't write.
 */
export async function failNotetaker(
  firestore: Firestore,
  input: {
    botId: string;
    status: 'failed' | 'cancelled';
    failureReason?: string | null;
    /** The words on the note for a bot's final status and reason. */
    messageFor: (status: string, reason: string | null) => string;
  },
  log: { error: (o: any, m?: string) => void; info?: (o: any, m?: string) => void },
): Promise<{ changed: boolean; bot: MeetingBot | null }> {
  if (!isPostgresEnabled()) return { changed: false, bot: null };
  const outcome = await withTx(async (client) => {
    const { rows: [row] } = await client.query('SELECT * FROM meeting_bots WHERE id = $1 FOR UPDATE', [input.botId]);
    if (!row) return null;
    const rankBefore = Number(row.status_rank);
    let final = row;
    let changed = false;
    if (!['done', 'failed', 'cancelled'].includes(row.status)) {
      const { rows: [updated] } = await client.query(
        `UPDATE meeting_bots
            SET status = $2, status_rank = $3, failure_reason = $4, meeting_url_ciphertext = NULL, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [input.botId, input.status, BOT_STATUS_RANK[input.status], input.status === 'failed' ? (input.failureReason ?? 'error') : null],
      );
      final = updated;
      changed = true;
    }
    // A bot that recorded (done) never fails its note.
    if (final.status !== 'failed' && final.status !== 'cancelled') return { final, changed, message: null, noteMarked: false };
    const message = input.messageFor(final.status, final.failure_reason ?? null);
    let noteMarked = false;
    if (final.note_id) {
      const marked = await client.query(
        `UPDATE notes SET status = 'error', error_message = $3, updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2 AND status IN ('recording', 'error')`,
        [final.note_id, final.workspace_id, message],
      );
      noteMarked = Boolean(marked.rowCount);
    }
    if (final.recall_bot_id) {
      // Once only: a replay mustn't reset a pending purge's attempts.
      const queued = changed || !(await client.query('SELECT 1 FROM recall_purges WHERE recall_bot_id = $1', [final.recall_bot_id])).rowCount;
      if (queued) {
        await enqueueRecallPurge(client, {
          recallBotId: final.recall_bot_id,
          reason: 'failed',
          leaveCall: rankBefore < BOT_STATUS_RANK.call_ended,
          traceId: final.trace_id ?? undefined,
        });
      }
    }
    return { final, changed, message, noteMarked };
  }, { log, fields: { meetingBotId: input.botId } });
  if (!outcome) return { changed: false, bot: null };
  const bot = botFromRow(outcome.final);
  if (!bot.noteId || outcome.message == null) return { changed: outcome.changed, bot };

  const notetaker: Record<string, unknown> = {
    botId: bot.id, status: toNotetakerStatus(bot.status), platform: bot.platform, rank: bot.statusRank,
  };
  if (bot.failureReason) notetaker.failureReason = bot.failureReason;
  const update: Record<string, unknown> = { notetaker, updatedAt: ISO_NOW() };
  if (outcome.noteMarked) Object.assign(update, { status: 'error', errorMessage: outcome.message });
  try {
    await firestore.doc(`workspaces/${bot.workspaceId}/notes/${bot.noteId}`).update(update);
  } catch (err) {
    if (!isFirestoreNotFound(err)) throw err;
    // No doc: fine for a note deleted meanwhile; a fault (retried) for a live one.
    const live = await getPool().query('SELECT 1 FROM notes WHERE id = $1', [bot.noteId]);
    if (live.rowCount) throw err;
    log.info?.({ noteId: bot.noteId, workspaceId: bot.workspaceId, userId: bot.uid }, 'notetaker_fail_note_gone');
  }
  return { changed: outcome.changed, bot };
}

/**
 * Move a notetaker's status forward (advanceBotStatus: Postgres, the truth) and
 * mirror what Postgres now holds onto its note's doc. The mirror carries the
 * status's rank, and a Firestore transaction refuses to write a lower one, so
 * two handlers finishing out of order can't move the doc backwards. A missing
 * doc for a live note throws (the task retries, and createServerNote restores
 * it); for a deleted note it's expected and logged.
 */
export async function advanceNotetaker(
  firestore: Firestore,
  input: { botId: string; status: BotStatus; failureReason?: string | null; recordingStartedAt?: Date; recordingEndedAt?: Date },
  log: { error: (o: any, m?: string) => void; info?: (o: any, m?: string) => void },
): Promise<{ changed: boolean; bot: MeetingBot | null }> {
  const { status, botId, ...opts } = input;
  const result = await advanceBotStatus(botId, status, opts);
  const bot = result.bot;
  if (!bot || !bot.noteId) return result;
  const ref = firestore.doc(`workspaces/${bot.workspaceId}/notes/${bot.noteId}`);
  const notetaker: Record<string, unknown> = {
    botId: bot.id, status: toNotetakerStatus(bot.status), platform: bot.platform, rank: bot.statusRank,
  };
  if (bot.failureReason) notetaker.failureReason = bot.failureReason;
  try {
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw Object.assign(new Error(`5 NOT_FOUND: ${ref.path}`), { code: 5 });
      const current = (snap.data()?.notetaker ?? {}) as { rank?: unknown };
      if (typeof current.rank === 'number' && current.rank > bot.statusRank) return; // a later status is already there
      tx.update(ref, { notetaker, updatedAt: ISO_NOW() });
    });
  } catch (err) {
    if (!isFirestoreNotFound(err)) throw err;
    const live = await getPool().query('SELECT 1 FROM notes WHERE id = $1', [bot.noteId]);
    if (live.rowCount) throw err;
    log.error({ err, noteId: bot.noteId, workspaceId: bot.workspaceId, userId: bot.uid }, 'notetaker_mirror_note_gone');
  }
  return result;
}
