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
export class WorkspaceBoundaryError extends Error {
  readonly code = 'WORKSPACE_BOUNDARY';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
  }
}

/**
 * The caller may write into `workspaceId` only if it is a brand-new workspace
 * (bootstrapped here with the caller as owner), or the caller is already a
 * member of it. A workspace row whose owner_uid is the caller but which is
 * missing the owner's membership row (legacy backfill) is healed. Anyone else
 * gets a WorkspaceBoundaryError: never add a stranger to an existing workspace.
 */
async function ensureWorkspaceAccess(
  client: import('pg').PoolClient,
  workspaceId: string,
  uid: string,
  name: string,
): Promise<void> {
  const created = await client.query(
    `INSERT INTO workspaces (id, owner_uid, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
    [workspaceId, uid, name],
  );
  if (created.rowCount) {
    await client.query(
      `INSERT INTO workspace_members (workspace_id, uid, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, uid],
    );
    return;
  }
  const member = await client.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND uid = $2', [
    workspaceId,
    uid,
  ]);
  if (member.rowCount) return;
  const healed = await client.query(
    `INSERT INTO workspace_members (workspace_id, uid, role)
       SELECT id, owner_uid, 'owner' FROM workspaces WHERE id = $1 AND owner_uid = $2
       ON CONFLICT (workspace_id, uid) DO NOTHING
       RETURNING uid`,
    [workspaceId, uid],
  );
  if (!healed.rowCount) {
    throw new WorkspaceBoundaryError(`${uid} is not a member of workspace ${workspaceId}`);
  }
}

async function upsertCoreToPostgres(
  input: MarkReadyInput,
  log: { error: (o: any, m?: string) => void },
): Promise<void> {
  if (!isPostgresEnabled()) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ensure user + workspace exist (best-effort; Firebase Auth is the
    // source of identity, but we want FK targets here).
    await client.query(
      `INSERT INTO users (uid, email)
         VALUES ($1, $2)
         ON CONFLICT (uid) DO NOTHING`,
      [input.authorUid, `${input.authorUid}@firebase.local`],
    );
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
 * An in-flight note untouched for this long is treated as stuck, and may be
 * re-queued. The pipeline doesn't bump updated_at as it works, so this is
 * measured from the kickoff. 3 h covers a 4 h recording end to end. The
 * stuck-note sweeper (plan PR-15) replaces this heuristic.
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
): Promise<{ queued: boolean; status: string | null }> {
  if (isPostgresEnabled()) {
    const outcome = await withTx(
      async (client) => {
        // Serialize kickoffs for this note id, including a brand-new note with
        // no row to lock yet: the second of two concurrent duplicates waits
        // here, then sees the first's 'queued' row and backs off.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`note-queue:${input.noteId}`]);
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

        // users.email is NOT NULL, and Postgres enforces that while forming the
        // row, before ON CONFLICT. A caller with no email claim (anonymous
        // sign-in) therefore needs the same placeholder markReady uses; a real
        // email, when present, always wins and is never overwritten by it.
        await client.query(
          `INSERT INTO users (uid, email, display_name)
             VALUES ($1, COALESCE($2::text, $1 || '@firebase.local'), $3)
           ON CONFLICT (uid) DO UPDATE SET
             email        = COALESCE($2::text, users.email),
             display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
          [input.authorUid, input.authorEmail || null, input.authorName || null],
        );
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
        return { queued: true, status: 'queued' };
      },
      { log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } },
    );
    if (!outcome.queued) return outcome;
  }

  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .set({ status: 'queued', updatedAt: ISO_NOW() }, { merge: true });
  return { queued: true, status: 'queued' };
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
