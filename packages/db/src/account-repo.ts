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
import { listStoragePurgesForAccount, runStoragePurge } from './storage-purges-repo';
import noteStorage from '@algominutes/ai/note-storage.cjs';

const { purgeWorkspaceObjects, cancelResumableUpload } = noteStorage as {
  purgeWorkspaceObjects: (args: { bucket: unknown; workspaceId: string }, log?: unknown) => Promise<number>;
  cancelResumableUpload: (uri: string, fetchImpl?: unknown) => Promise<void>;
};

export interface AccountDeletion {
  /** Whether a users row was deleted by this call (false on a retry). */
  deleted: boolean;
  /** Every workspace the account owned (from the tombstone, so also on a retry). */
  workspaceIds: string[];
  /** Upload session URIs still to cancel (from the tombstone, so also on a retry). */
  uploadSessionUris: string[];
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
      // Open GCS upload sessions: the rows cascade away below, but the URIs stay
      // valid for a week, so they're kept on the tombstone until cancelled.
      const sessions = await client.query<{ session_uri: string }>(
        'SELECT session_uri FROM upload_sessions WHERE uid = $1',
        [input.uid],
      );
      const tomb = await client.query<{ workspace_ids: string[]; pending_upload_sessions: string[] }>(
        `INSERT INTO account_deletions (uid, workspace_ids, pending_upload_sessions, trace_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (uid) DO UPDATE SET
           workspace_ids = ARRAY(
             SELECT DISTINCT w FROM unnest(account_deletions.workspace_ids || EXCLUDED.workspace_ids) AS w),
           pending_upload_sessions = ARRAY(
             SELECT DISTINCT u FROM unnest(account_deletions.pending_upload_sessions || EXCLUDED.pending_upload_sessions) AS u)
         RETURNING workspace_ids, pending_upload_sessions`,
        [input.uid, ownedIds, sessions.rows.map((r) => r.session_uri), input.traceId ?? null],
      );
      const workspaceIds = tomb.rows[0]!.workspace_ids;
      const uploadSessionUris = tomb.rows[0]!.pending_upload_sessions;

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
        uploadSessionUris,
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

/** An upload session was cancelled: take it off the tombstone. */
export async function clearCancelledUploadSession(uid: string, sessionUri: string): Promise<void> {
  await getPool().query(
    'UPDATE account_deletions SET pending_upload_sessions = array_remove(pending_upload_sessions, $2) WHERE uid = $1',
    [uid, sessionUri],
  );
}

type Log = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void };

export interface FinishAccountDeletionDeps {
  auth: { deleteUser: (uid: string) => Promise<void> };
  firestore: Firestore;
  bucket: unknown;
  fetch?: unknown;
}

export interface FinishAccountDeletionResult {
  /** Everything outside Postgres is gone and so is the Auth user. */
  complete: boolean;
  /** Failures before the Auth step (each is logged). */
  errors: number;
  authDeleted: boolean;
  /** The Auth delete itself failed (errors was 0). */
  authFailed: boolean;
}

/**
 * Everything after deleteAccountData, shared by the route and the sweeper (an
 * incomplete deletion the client never retried is finished here too):
 *   1. cancel the account's open GCS upload sessions, so nothing lands later;
 *   2. run its pending purges (each note's mirror doc and audio, every version);
 *   3. delete its own Firestore docs, then everything under its workspaces'
 *      storage prefixes;
 *   4. only if all of that worked, delete the Auth user and mark the tombstone
 *      complete.
 * Idempotent: run it again and it does only what's left.
 */
export async function finishAccountDeletion(
  deps: FinishAccountDeletionDeps,
  input: { uid: string; workspaceIds: string[]; uploadSessionUris: string[] },
  log: Log,
): Promise<FinishAccountDeletionResult> {
  const { uid } = input;
  const ownWorkspaces = [...new Set([...input.workspaceIds, `workspace_${uid}`])];
  let errors = 0;

  for (const sessionUri of input.uploadSessionUris) {
    try {
      await cancelResumableUpload(sessionUri, deps.fetch);
      await clearCancelledUploadSession(uid, sessionUri);
    } catch (err) {
      errors += 1;
      log.error({ err, userId: uid }, 'delete_account_upload_cancel_failed');
    }
  }
  const purges = await listStoragePurgesForAccount({ uid, workspaceIds: ownWorkspaces });
  for (const p of purges) {
    if (!(await runStoragePurge({ bucket: deps.bucket, firestore: deps.firestore }, p, log))) errors += 1;
  }
  try {
    await deleteAccountMirror(deps.firestore, { uid, workspaceIds: ownWorkspaces });
  } catch (err) {
    errors += 1;
    log.error({ err, userId: uid, workspaceIds: ownWorkspaces }, 'delete_account_mirror_failed');
  }
  for (const workspaceId of ownWorkspaces) {
    try {
      await purgeWorkspaceObjects({ bucket: deps.bucket, workspaceId }, log);
    } catch (err) {
      errors += 1;
      log.error({ err, userId: uid, workspaceId }, 'delete_account_storage_failed');
    }
  }
  if (errors) {
    // Something outside Postgres is still there. Auth stays, so the client (or
    // the sweeper) can retry, and the retry re-runs exactly what's left.
    log.error({ userId: uid, errors }, 'delete_account_incomplete');
    return { complete: false, errors, authDeleted: false, authFailed: false };
  }

  try {
    await deps.auth.deleteUser(uid);
  } catch (err) {
    if ((err as { code?: string })?.code !== 'auth/user-not-found') {
      log.error({ err, userId: uid }, 'delete_account_auth_failed');
      return { complete: false, errors: 0, authDeleted: false, authFailed: true };
    }
    // An earlier attempt already did it.
  }
  // The account is gone. Failing to mark the tombstone complete must not
  // turn that into a 500 for the user: log it, and the sweeper (which re-runs
  // open tombstones, idempotently) marks it later.
  await completeAccountDeletion(uid)
    .catch((err) => log.error({ err, userId: uid }, 'delete_account_tombstone_complete_failed'));
  return { complete: true, errors: 0, authDeleted: true, authFailed: false };
}

/** Deletions whose tombstone is still open after `olderThanMs` (the client gave up, or crashed). */
export async function listIncompleteAccountDeletions(
  input: { olderThanMs: number; limit?: number },
): Promise<Array<{ uid: string; workspaceIds: string[]; uploadSessionUris: string[]; traceId: string | null }>> {
  const { rows } = await getPool().query(
    `SELECT uid, workspace_ids, pending_upload_sessions, trace_id FROM account_deletions
      WHERE completed_at IS NULL AND requested_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY requested_at ASC LIMIT $2`,
    [input.olderThanMs, input.limit ?? 50],
  );
  return rows.map((r) => ({
    uid: r.uid, workspaceIds: r.workspace_ids, uploadSessionUris: r.pending_upload_sessions, traceId: r.trace_id,
  }));
}

/** Drop tombstones completed more than `olderThanDays` ago (no token issued before then is still valid). */
export async function pruneCompletedAccountDeletions(input: { olderThanDays: number }): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM account_deletions
      WHERE completed_at IS NOT NULL AND completed_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [input.olderThanDays],
  );
  return rowCount ?? 0;
}
