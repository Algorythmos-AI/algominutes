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
    edit: { noteId: string; title?: string; summary?: NoteEditSummary },
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

async function upsertCoreToPostgres(input: MarkReadyInput): Promise<void> {
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
    await client.query(
      `INSERT INTO workspaces (id, owner_uid, name)
         VALUES ($1, $2, 'My Workspace')
         ON CONFLICT (id) DO NOTHING`,
      [input.workspaceId, input.authorUid],
    );
    await client.query(
      `INSERT INTO workspace_members (workspace_id, uid, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (workspace_id, uid) DO NOTHING`,
      [input.workspaceId, input.authorUid],
    );

    await client.query(
      `INSERT INTO notes (
         id, workspace_id, author_uid, status, source_type,
         storage_path, mime_type, duration_sec, updated_at
       ) VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, NOW())
       ON CONFLICT (id) DO UPDATE
         SET status        = EXCLUDED.status,
             storage_path  = COALESCE(EXCLUDED.storage_path, notes.storage_path),
             mime_type     = COALESCE(EXCLUDED.mime_type, notes.mime_type),
             duration_sec  = COALESCE(EXCLUDED.duration_sec, notes.duration_sec),
             updated_at    = NOW()`,
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
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
      await upsertCoreToPostgres(input);
      pgWritten = true;
    } catch (err) {
      log.error({ err, noteId: input.noteId }, 'pg_mark_ready_failed');
      // Do not propagate; we still mirror to Firestore so the user sees
      // the result. Background reconciliation can re-sync.
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
        `UPDATE notes SET status='error', error_message=$2, updated_at=NOW() WHERE id=$1`,
        [input.noteId, input.errorMessage],
      );
    } catch (err) {
      log.error({ err, noteId: input.noteId }, 'pg_mark_error_failed');
    }
  }
  await firestore
    .doc(`workspaces/${input.workspaceId}/notes/${input.noteId}`)
    .update({ status: 'error', errorMessage: input.errorMessage, updatedAt: ISO_NOW() });
}

/**
 * Persist a manual note edit (title / summary) to Postgres (system of record)
 * and mirror it to Firestore. Unlike markReady, a Postgres failure is NOT
 * swallowed — the edit endpoint fails hard so the Firestore cache never leads
 * the record. Only the fields provided are touched; a note without a Postgres
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
