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
// client retries. Nothing else retries a purge yet (the PR-15 sweeper), so a
// 200 has to mean everything is gone.
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
// before. `deps` lets tests supply Auth, Firestore, the bucket and (to force a
// Postgres failure) the repo call.

import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import noteStorageModule from '@algominutes/ai/note-storage.cjs';
import {
  deleteAccountData, deleteAccountMirror, completeAccountDeletion, listStoragePurgesForUid, runStoragePurge,
} from '@algominutes/db';

const { purgeWorkspaceObjects } = noteStorageModule;

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

  // 2. Each note's mirror doc and audio, including purges left by an earlier attempt.
  const purges = await listStoragePurgesForUid(uid);
  for (const p of purges) {
    if (!(await runStoragePurge({ bucket, firestore }, p, log))) summary.firestoreErrors += 1;
  }

  // 3. The account's own docs and storage. The owned workspaces come from the
  // tombstone (also on a retry). The personal id is added in case its
  // workspace doc exists in Firestore without ever reaching Postgres.
  const ownWorkspaces = [...new Set([...pg.workspaceIds, `workspace_${uid}`])];
  summary.workspacesAffected = pg.workspaceIds.length;
  try {
    await deleteAccountMirror(firestore, { uid, workspaceIds: ownWorkspaces });
  } catch (err) {
    summary.firestoreErrors += 1;
    log.error({ err, summary }, 'delete_account_mirror_failed');
  }
  for (const workspaceId of ownWorkspaces) {
    try {
      await purgeWorkspaceObjects({ bucket, workspaceId }, log);
    } catch (err) {
      summary.firestoreErrors += 1;
      log.error({ err, workspaceId }, 'delete_account_storage_failed');
    }
  }
  if (summary.firestoreErrors) {
    // Something outside Postgres is still there. Auth stays, so the client
    // can retry, and the retry re-runs exactly what's left.
    log.error({ summary }, 'delete_account_incomplete');
    return res.status(500).json({ error: 'delete_incomplete', summary });
  }

  // 4. Auth last, so a failure above leaves the token usable for a retry.
  try {
    await auth.deleteUser(uid);
    summary.authDeleted = true;
  } catch (err) {
    if (err?.code === 'auth/user-not-found') {
      summary.authDeleted = true; // an earlier attempt already did it
    } else {
      log.error({ err, summary }, 'delete_account_auth_failed');
      return res.status(500).json({ error: 'auth_deletion_failed', summary });
    }
  }

  await completeAccountDeletion(uid).catch((err) => log.error({ err }, 'delete_account_tombstone_complete_failed'));
  log.info({ summary, pgDeleted: pg.deleted }, 'delete_account_complete');
  return res.status(200).json({ ok: true, summary });
}
