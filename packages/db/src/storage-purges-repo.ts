/**
 * The queue of what a deleted note leaves outside Postgres (migration 014):
 * its Cloud Storage objects, and its Firestore mirror doc.
 *
 * notesRepo.deleteNote writes a row in the same transaction that deletes the
 * note, so the purge can't be lost. runStoragePurge deletes the mirror doc
 * (again: deleteNote already did, unless the process died first) and the
 * objects, and only then the row. A failure leaves the row with its attempt
 * count and last error, and the PR-15 sweeper retries anything left
 * (listPendingStoragePurges).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getPool } from './db';
import noteStorage from '@algominutes/ai/note-storage.cjs';

const { purgeNoteObjects } = noteStorage as {
  purgeNoteObjects: (
    args: { bucket: unknown; workspaceId: string; noteId: string; includeScratch: boolean },
    log?: { info: (o: any, m?: string) => void },
  ) => Promise<string[]>;
};

export interface StoragePurge {
  id: number;
  noteId: string;
  workspaceId: string;
  storagePath: string | null;
  includeScratch: boolean;
  /** Set when an account deletion queued it, so a retry can find it by uid. */
  uid: string | null;
  traceId: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

const COLUMNS = `id, note_id, workspace_id, storage_path, include_scratch, uid, trace_id, attempts, last_error, created_at`;

function toPurge(r: any): StoragePurge {
  return {
    id: Number(r.id),
    noteId: r.note_id,
    workspaceId: r.workspace_id,
    storagePath: r.storage_path,
    includeScratch: r.include_scratch,
    uid: r.uid ?? null,
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

/**
 * Purges still worth retrying (fewer than maxAttempts), oldest first: what the
 * sweeper runs. Stuck ones are excluded, so they can never crowd out newer
 * purges; listStuckStoragePurges reports them.
 */
export async function listPendingStoragePurges(limit = 50, maxAttempts = 10): Promise<StoragePurge[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM storage_purges WHERE attempts < $2 ORDER BY created_at ASC, id ASC LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map(toPurge);
}

/** Purges that have failed maxAttempts times: for a human (the alert counts them). */
export async function listStuckStoragePurges(limit = 50, maxAttempts = 10): Promise<StoragePurge[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM storage_purges WHERE attempts >= $2 ORDER BY created_at ASC, id ASC LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map(toPurge);
}

/**
 * An account's purges still pending, oldest first: the ones its deletion
 * queued (tagged with the uid), plus any left in its workspaces by earlier
 * single-note deletions that never finished.
 */
export async function listStoragePurgesForAccount(input: { uid: string; workspaceIds: string[] }): Promise<StoragePurge[]> {
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS} FROM storage_purges
      WHERE uid = $1 OR workspace_id = ANY($2::text[])
      ORDER BY created_at ASC, id ASC`,
    [input.uid, input.workspaceIds],
  );
  return rows.map(toPurge);
}

/**
 * Delete one purge's mirror doc and objects, then its row. On failure the row stays, with the
 * attempt counted and the error recorded, and the error is logged. Returns
 * whether it completed; it never throws, because a failed purge is retried,
 * not surfaced to the user whose note is already gone.
 */
export async function runStoragePurge(
  { bucket, firestore }: { bucket: unknown; firestore: Firestore },
  purge: StoragePurge,
  log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void },
): Promise<boolean> {
  // The deleting request's traceId travels with the purge, so a later retry
  // (the sweeper, with its own logger) still logs under it (CLAUDE.md §1).
  // (Only when set: an undefined key would override the logger's own traceId.)
  const fields = {
    ...(purge.traceId ? { traceId: purge.traceId } : {}),
    noteId: purge.noteId,
    workspaceId: purge.workspaceId,
    purgeId: purge.id,
  };
  try {
    // Idempotent: deleting a missing doc succeeds.
    await firestore.doc(`workspaces/${purge.workspaceId}/notes/${purge.noteId}`).delete();
    await purgeNoteObjects(
      {
        bucket,
        workspaceId: purge.workspaceId,
        noteId: purge.noteId,
        includeScratch: purge.includeScratch,
      },
      { info: (o: any, m?: string) => log.info({ ...fields, ...o }, m) },
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
