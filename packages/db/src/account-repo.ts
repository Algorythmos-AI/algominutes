/**
 * Account deletion (POST /v1/account/delete): the repo half.
 *
 * Postgres is the source of truth, so it goes first, in one transaction:
 * every note the account owns (in its own workspaces, or authored elsewhere)
 * gets a storage_purges row tagged with the uid, then the users row is
 * deleted. ON DELETE CASCADE removes the rest: owned workspaces and their
 * notes, transcripts, summaries, embeddings, memberships, subscriptions, push
 * tokens, terms, upload sessions. The purges then remove each note's mirror
 * doc and audio (storage-purges-repo). deleteAccountMirror removes the
 * account's own Firestore docs. The route deletes the Auth user last.
 *
 * Every step is idempotent. A retry after a partial failure finds the users
 * row gone, runs the purges still pending for the uid, and finishes.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isPostgresEnabled, withTx } from './db';

export interface AccountDeletion {
  /** Whether a users row was deleted by this call (false on a retry). */
  deleted: boolean;
  /** The account's own workspaces (deleted with it), for the mirror and storage cleanup. */
  workspaceIds: string[];
  notesQueued: number;
  membershipsDeleted: number;
}

export async function deleteAccountData(
  input: { uid: string; traceId?: string | null },
  log: { error: (o: any, m?: string) => void },
): Promise<AccountDeletion> {
  if (!isPostgresEnabled()) throw new Error('deleteAccountData needs Postgres (WRITE_POSTGRES=true)');
  return withTx(
    async (client) => {
      const owned = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE owner_uid = $1', [input.uid]);
      const workspaceIds = owned.rows.map((r) => r.id);
      const notes = await client.query<{ id: string; workspace_id: string; storage_path: string | null }>(
        `SELECT id, workspace_id, storage_path FROM notes
          WHERE workspace_id = ANY($1::text[]) OR author_uid = $2`,
        [workspaceIds, input.uid],
      );
      for (const n of notes.rows) {
        await client.query(
          `INSERT INTO storage_purges (note_id, workspace_id, storage_path, include_scratch, uid, trace_id)
             VALUES ($1, $2, $3, TRUE, $4, $5)`,
          [n.id, n.workspace_id, n.storage_path, input.uid, input.traceId ?? null],
        );
      }
      const members = await client.query('SELECT 1 FROM workspace_members WHERE uid = $1', [input.uid]);
      const gone = await client.query('DELETE FROM users WHERE uid = $1', [input.uid]);
      return {
        deleted: (gone.rowCount ?? 0) > 0,
        workspaceIds,
        notesQueued: notes.rows.length,
        membershipsDeleted: members.rowCount ?? 0,
      };
    },
    { log, fields: { userId: input.uid } },
  );
}

/**
 * The account's own Firestore docs, after Postgres: each workspace doc (the
 * notes under it are removed by their purges) and the per-uid rate-limit
 * counter. Deleting a missing doc succeeds, so this is safe to repeat.
 */
export async function deleteAccountMirror(
  firestore: Firestore,
  input: { uid: string; workspaceIds: string[] },
): Promise<void> {
  for (const ws of input.workspaceIds) {
    await firestore.doc(`workspaces/${ws}`).delete();
  }
  await firestore.doc(`rateLimits/${input.uid}`).delete();
}
