/**
 * A tombstone per deleted note (migration 018), ids only. A note's purge row
 * goes once its doc and objects are gone; the tombstone outlives it, so a
 * stale client can't upload into the note, or re-queue it, afterwards. The
 * sweeper prunes tombstones (db-job sweep).
 */
import type { PoolClient } from 'pg';
import { getPool } from './db';

/** Record the deletion, inside the deleting transaction. Idempotent. */
export async function recordNoteDeleted(
  client: PoolClient,
  input: { noteId: string; workspaceId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO deleted_notes (note_id, workspace_id) VALUES ($1, $2)
     ON CONFLICT (note_id, workspace_id) DO UPDATE SET deleted_at = NOW()`,
    [input.noteId, input.workspaceId],
  );
}

/**
 * Whether the note was deleted from this workspace: its purge is still pending,
 * or its tombstone remains. Take the note lock first (lockNoteId), so a
 * deletion either committed before this read or waits for the caller.
 */
export async function isNoteDeleted(
  client: PoolClient,
  input: { noteId: string; workspaceId: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM storage_purges WHERE note_id = $1 AND workspace_id = $2
     UNION ALL
     SELECT 1 FROM deleted_notes WHERE note_id = $1 AND workspace_id = $2
     LIMIT 1`,
    [input.noteId, input.workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Drop tombstones older than olderThanDays. Returns how many went. */
export async function pruneDeletedNotes(input: { olderThanDays: number }): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM deleted_notes WHERE deleted_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [input.olderThanDays],
  );
  return rowCount ?? 0;
}
