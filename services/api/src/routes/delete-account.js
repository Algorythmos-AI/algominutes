// POST|DELETE /v1/account/delete: account deletion (App Store 5.1.1(v), GDPR).
//
// The single deletion path, in this order:
//   1. Postgres, in one transaction (account-repo deleteAccountData): a purge
//      is queued for every note the account owns, then the users row goes and
//      ON DELETE CASCADE removes everything else. If this fails, nothing else
//      happens: 500, Auth intact, the client retries.
//   2. The purges (storage-purges-repo): each note's Firestore doc and audio.
//      Pending ones from an earlier attempt run too (found by uid).
//   3. The account's own Firestore docs (its workspace docs with their
//      subcollections, its analytics docs, its rate-limit counter), then any
//      leftover uploads under its workspaces' storage prefixes.
//   4. The Auth user, last. Then the tombstone is marked complete.
// Only then 200. ANY failure in 2-4 answers 500 with Auth intact, so the
// client retries. If it never does, the sweeper (db-job JOB_NAME=sweep)
// finishes the deletion from the tombstone. A 200 means everything is gone.
//
// Every step is idempotent. A retry after any failure finds the users row
// already gone, reads the owned workspaces from the tombstone
// (account_deletions), and finishes what's left.
//
// It used to delete Firestore first and rely on the functions/ trigger
// onNoteDeleted (never deployed by this pipeline) for the rest. Every step was
// best-effort, and Auth was deleted and 200 returned even when a step had
// failed, so the user could never retry.
//
// Self-authenticating (verifyIdToken) rather than behind authMiddleware, as
// before. `deps` lets tests supply Auth, Firestore, the bucket, fetch (for the
// upload-session cancel) and, to force a Postgres failure, the repo call.

import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { deleteAccountData, finishAccountDeletion } from '@algominutes/db';

export async function deleteAccountRoute(req, res, deps = {}) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const auth = deps.auth ?? getAuth();
  let uid;
  try {
    uid = (await auth.verifyIdToken(token)).uid;
  } catch (err) {
    // Routine (expired/forged tokens), so warn, not error, but never silent.
    req.log.warn({ err }, 'delete_account_token_invalid');
    return res.status(401).json({ error: 'Invalid token' });
  }
  const firestore = deps.firestore ?? getFirestore();
  const bucket = deps.bucket ?? getStorage().bucket();
  const log = req.log.child({ userId: uid });
  log.info({}, 'delete_account_starting');

  const summary = {
    workspacesAffected: 0,
    notesDeleted: 0,
    notesNotFound: 0,
    pgMembershipsDeleted: 0,
    firestoreErrors: 0,
    pgErrors: 0,
    authDeleted: false,
  };

  // 1. Postgres first. Nothing else runs unless it commits.
  let pg;
  try {
    pg = await (deps.deleteAccountData ?? deleteAccountData)({ uid, traceId: req.traceId }, log);
  } catch (err) {
    summary.pgErrors = 1;
    log.error({ err, summary }, 'delete_account_pg_failed');
    return res.status(500).json({ error: 'delete_failed', summary });
  }
  summary.notesDeleted = pg.notesQueued;
  summary.pgMembershipsDeleted = pg.membershipsDeleted;

  // 2-4 (account-repo finishAccountDeletion, shared with the sweeper): cancel
  // the open upload sessions, run the purges, delete the account's own docs and
  // storage, then the Auth user, only if everything before it worked.
  summary.workspacesAffected = pg.workspaceIds.length;
  const done = await finishAccountDeletion(
    { auth, firestore, bucket, fetch: deps.fetch },
    { uid, workspaceIds: pg.workspaceIds, uploadSessionUris: pg.uploadSessionUris },
    log,
  );
  summary.firestoreErrors = done.errors;
  summary.authDeleted = done.authDeleted;
  if (done.authFailed) return res.status(500).json({ error: 'auth_deletion_failed', summary });
  if (!done.complete) return res.status(500).json({ error: 'delete_incomplete', summary });

  log.info({ summary, pgDeleted: pg.deleted }, 'delete_account_complete');
  return res.status(200).json({ ok: true, summary });
}
