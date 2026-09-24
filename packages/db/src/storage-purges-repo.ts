/**
 * The queue of note audio to delete from Cloud Storage (migration 014).
 *
 * notesRepo.deleteNote writes a row in the same transaction that deletes the
 * note, so the purge can't be lost. runStoragePurge deletes the objects and
 * only then the row. A failure leaves the row with its attempt count and last
 * error, and the PR-15 sweeper retries anything left (listPendingStoragePurges).
 */
import { getPool } from './db';
import noteStorage from '@algominutes/ai/note-storage.cjs';

const { purgeNoteObjects } = noteStorage as {
  purgeNoteObjects: (
    args: { bucket: unknown; workspaceId: string; noteId: string; storagePath: string | null; includeScratch: boolean },
    log?: { info: (o: any, m?: string) => void },
  ) => Promise<string[]>;
};

export interface StoragePurge {
  id: number;
  noteId: string;
  workspaceId: string;
  storagePath: string | null;
  includeScratch: boolean;
  traceId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

const COLUMNS = `id, note_id, workspace_id, storage_path, include_scratch, trace_id, attempts, last_error, created_at`;

function toPurge(r: any): StoragePurge {
  return {
    id: Number(r.id),
    noteId: r.note_id,
    workspaceId: r.workspace_id,
    storagePath: r.storage_path,
    includeScratch: r.include_scratch,
    traceId: r.trace_id,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: new Date(r.created_at),
  };
}

export async function getStoragePurge(id: number): Promise<StoragePurge | null> {
  const { rows } = await getPool().query(`SELECT ${COLUMNS} FROM storage_purges WHERE id = $1`, [id]);
  return rows[0] ? toPurge(rows[0]) : null;
}

/** Purges still pending, oldest first (what the sweeper retries, and what an alert counts). */
export async function listPendingStoragePurges(limit = 50): Promise<StoragePurge[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM storage_purges ORDER BY created_at ASC, id ASC LIMIT $1`,
    [limit],
  );
  return rows.map(toPurge);
}

/**
 * Delete one purge's objects, then its row. On failure the row stays, with the
 * attempt counted and the error recorded, and the error is logged. Returns
 * whether it completed; it never throws, because a failed purge is retried,
 * not surfaced to the user whose note is already gone.
 */
export async function runStoragePurge(
  bucket: unknown,
  purge: StoragePurge,
  log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void },
): Promise<boolean> {
  const fields = { noteId: purge.noteId, workspaceId: purge.workspaceId, purgeId: purge.id };
  try {
    await purgeNoteObjects(
      {
        bucket,
        workspaceId: purge.workspaceId,
        noteId: purge.noteId,
        storagePath: purge.storagePath,
        includeScratch: purge.includeScratch,
      },
      log,
    );
    await getPool().query('DELETE FROM storage_purges WHERE id = $1', [purge.id]);
    return true;
  } catch (err) {
    log.error({ err, ...fields, attempts: purge.attempts + 1 }, 'note_storage_purge_failed');
    await getPool()
      .query(
        `UPDATE storage_purges SET attempts = attempts + 1, last_error = $2, updated_at = NOW() WHERE id = $1`,
        [purge.id, String((err as Error)?.message ?? err).slice(0, 1000)],
      )
      .catch((recordErr) => log.error({ err: recordErr, ...fields }, 'note_storage_purge_record_failed'));
    return false;
  }
}
