/**
 * Account deletion (POST /v1/account/delete): the repo half.
 *
 * Postgres is the source of truth, so it goes first, in one transaction:
 *   - the users row and the account's workspaces are locked, so a note
 *     inserted concurrently waits and then fails its foreign key, rather than
 *     slipping in without a purge;
 *   - a tombstone (account_deletions) records the owned workspace ids, for a
 *     retry after the rows are gone, and stops ensureUser re-creating the
 *     account from a still-valid token;
 *   - every note the account owns (in its workspaces, or authored elsewhere)
 *     gets a storage_purges row tagged with the uid;
 *   - rows that would otherwise outlive the account are deleted: dead letters
 *     for its workspaces or notes, and its support requests and analytics
 *     events (their foreign keys only NULL the uid, keeping the content);
 *   - the users row is deleted, and ON DELETE CASCADE removes the rest
 *     (workspaces and their notes, transcripts, summaries, embeddings,
 *     memberships, subscriptions, push tokens, terms, upload sessions).
 * The purges then remove each note's mirror doc and audio
 * (storage-purges-repo). deleteAccountMirror removes the account's own
 * Firestore docs, and the route deletes the Auth user last.
 *
 * Every step is idempotent. A retry finds the users row gone, reads the owned
 * workspaces from the tombstone, runs the purges still pending for the uid,
 * and finishes.
 *
 * Shared workspaces: an owned workspace goes with its owner, including other
 * members' notes in it. Today every workspace is personal (workspace_<uid>);
 * before sharing ships, deletion must transfer or refuse shared workspaces
 * (BLOCKERS).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getPool, isPostgresEnabled, withTx } from './db';

export interface AccountDeletion {
  /** Whether a users row was deleted by this call (false on a retry). */
  deleted: boolean;
  /** Every workspace the account owned (from the tombstone, so also on a retry). */
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
      await client.query('SELECT 1 FROM users WHERE uid = $1 FOR UPDATE', [input.uid]);
      const owned = await client.query<{ id: string }>(
        'SELECT id FROM workspaces WHERE owner_uid = $1 FOR UPDATE',
        [input.uid],
      );
      const ownedIds = owned.rows.map((r) => r.id);
      const tomb = await client.query<{ workspace_ids: string[] }>(
        `INSERT INTO account_deletions (uid, workspace_ids, trace_id) VALUES ($1, $2, $3)
         ON CONFLICT (uid) DO UPDATE SET workspace_ids = ARRAY(
           SELECT DISTINCT w FROM unnest(account_deletions.workspace_ids || EXCLUDED.workspace_ids) AS w)
         RETURNING workspace_ids`,
        [input.uid, ownedIds, input.traceId ?? null],
      );
      const workspaceIds = tomb.rows[0]!.workspace_ids;

      const notes = await client.query<{ id: string; workspace_id: string; storage_path: string | null }>(
        `SELECT id, workspace_id, storage_path FROM notes
          WHERE workspace_id = ANY($1::text[]) OR author_uid = $2`,
        [ownedIds, input.uid],
      );
      for (const n of notes.rows) {
        await client.query(
          `INSERT INTO storage_purges (note_id, workspace_id, storage_path, include_scratch, uid, trace_id)
             VALUES ($1, $2, $3, TRUE, $4, $5)`,
          [n.id, n.workspace_id, n.storage_path, input.uid, input.traceId ?? null],
        );
      }
      await client.query(
        'DELETE FROM dead_letter WHERE workspace_id = ANY($1::text[]) OR note_id = ANY($2::text[])',
        [workspaceIds, notes.rows.map((n) => n.id)],
      );
      await client.query('DELETE FROM support_requests WHERE uid = $1', [input.uid]);
      await client.query('DELETE FROM analytics_events WHERE uid = $1', [input.uid]);
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
 * The account's own Firestore docs, after Postgres and the purges:
 *   - each owned workspace doc WITH its subcollections (recursiveDelete). The
 *     clients create a note doc before any Postgres row exists, so a note that
 *     was never processed has a doc but no purge;
 *   - the root `analytics` docs of those workspaces;
 *   - the per-uid rate-limit counter.
 * Deleting what's already gone succeeds, so this is safe to repeat.
 */
export async function deleteAccountMirror(
  firestore: Firestore,
  input: { uid: string; workspaceIds: string[] },
): Promise<void> {
  for (const ws of input.workspaceIds) {
    await firestore.recursiveDelete(firestore.doc(`workspaces/${ws}`));
    const events = await firestore.collection('analytics').where('workspaceId', '==', ws).get();
    for (const d of events.docs) await d.ref.delete();
  }
  await firestore.doc(`rateLimits/${input.uid}`).delete();
}

/** Mark the tombstone complete (the Auth user is gone too). */
export async function completeAccountDeletion(uid: string): Promise<void> {
  await getPool().query('UPDATE account_deletions SET completed_at = NOW() WHERE uid = $1', [uid]);
}

/**
 * Whether the account was deleted (it has a tombstone). Checked by routes
 * before they hand out anything a deleted account's still-valid token could
 * use, such as a GCS upload session.
 */
export async function isAccountDeleted(uid: string): Promise<boolean> {
  const { rowCount } = await getPool().query('SELECT 1 FROM account_deletions WHERE uid = $1', [uid]);
  return (rowCount ?? 0) > 0;
}
