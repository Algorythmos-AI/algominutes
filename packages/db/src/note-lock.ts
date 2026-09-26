/**
 * Internal (not re-exported from index.ts). Serialises everything that decides
 * whether a note exists, is queued, or may still receive an upload: the kickoff
 * (markQueued), deleteNote, and createUploadSession. Held until the transaction
 * ends, and it works for a note id that has no row yet. Always taken FIRST, before
 * any row lock (users, notes), so these transactions can't deadlock each other.
 */
import type { PoolClient } from 'pg';

export async function lockNoteId(client: PoolClient, noteId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`note-queue:${noteId}`]);
}
