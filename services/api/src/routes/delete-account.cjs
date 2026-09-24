// services/api delete-account.cjs — Apple App Store + GDPR delete-account.
//
// Consolidated into services/api (BUILD-PLAN §3.1) from
// functions/delete-account.cjs. The ONLY change from the source is the
// shared-lib import path: the logger comes from @algominutes/ai.
//
// Authenticated endpoint that purges a user's data:
//   1. Find every note in workspaces where the user is `owner` (auth scope).
//   2. Delete each Firestore notes/{noteId} doc — fires onNoteDeleted in
//      functions/index.js which handles Storage + Postgres cascade.
//   3. Remove user from workspace_members (Postgres).
//   4. Delete the Firebase Auth user record (last, so any auth-required
//      cleanup above runs first).
//
// Idempotent: re-running after a partial failure is safe — Firestore
// deletes are no-ops on already-deleted docs, workspace_members DELETE
// is idempotent, Firebase Auth deleteUser throws auth/user-not-found
// which we treat as success.
//
// This handler self-authenticates (verifyIdToken) using the same primitive as
// the shared auth middleware, and manages CORS/OPTIONS/method itself, so it is
// mounted as a raw handler rather than behind the shared auth middleware. The
// onNoteDeleted Firestore-trigger cascade it relies on stays a Firebase
// Function (a genuine trigger) — see the report.

'use strict';

const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const sharedLogger = require('@algominutes/ai/logger.cjs');

async function handleDeleteAccount({ req, res, pgPool, applyCors, traceId, log: baseLog, traceIdFrom }) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Backwards-compat: the wrapper now supplies { traceId, log }, but
  // older call sites passed traceIdFrom for self-construction. Prefer
  // the wrapper-supplied values when present.
  if (!baseLog) {
    const tid = traceId || (traceIdFrom ? traceIdFrom(req.headers) : undefined);
    baseLog = sharedLogger.logger.child({ traceId: tid, fn: 'deleteAccount' });
  }

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let uid, email;
  try {
    const decoded = await getAuth().verifyIdToken(token);
    uid = decoded.uid;
    email = decoded.email || null;
  } catch (err) {
    // Routine (expired/forged tokens), so warn, not error, but never silent.
    baseLog.warn({ err }, 'delete_account_token_invalid');
    return res.status(401).json({ error: 'Invalid token' });
  }

  const log = baseLog.child({ uid });
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

  try {
    // 1. Find owned workspaces in Postgres.
    const owned = await pgPool().query(
      `SELECT workspace_id FROM workspace_members WHERE uid = $1 AND role = 'owner'`,
      [uid],
    );
    summary.workspacesAffected = owned.rows.length;

    // 2. Find every note in those workspaces. Fetch workspace_id alongside
    //    the note id so we can target the correct Firestore path —
    //    the SPA writes notes at `workspaces/{wsId}/notes/{noteId}`,
    //    NOT root `notes/{noteId}`.
    let noteRefs = [];
    if (owned.rows.length > 0) {
      const wsIds = owned.rows.map(r => r.workspace_id);
      const notes = await pgPool().query(
        `SELECT id, workspace_id FROM notes WHERE workspace_id = ANY($1)`,
        [wsIds],
      );
      noteRefs = notes.rows.map(r => ({ id: r.id, workspaceId: r.workspace_id }));
    }
    log.info({ workspaceCount: owned.rows.length, noteCount: noteRefs.length }, 'delete_account_scope');

    // 3. Delete each Firestore note doc — fires onNoteDeleted cascade.
    //    Best-effort batched (Firestore batch limit is 500). Path must
    //    match where the SPA writes (workspaces/{wsId}/notes/{noteId})
    //    or the batch silently no-ops and the cascade never runs.
    const fs = getFirestore();
    for (let i = 0; i < noteRefs.length; i += 400) {
      const batch = fs.batch();
      const slice = noteRefs.slice(i, i + 400);
      for (const { id, workspaceId } of slice) {
        batch.delete(fs.doc(`workspaces/${workspaceId}/notes/${id}`));
      }
      try {
        await batch.commit();
        summary.notesDeleted += slice.length;
      } catch (err) {
        summary.firestoreErrors++;
        log.warn({ err: { message: err?.message }, batchSize: slice.length }, 'delete_account_firestore_batch_failed');
        // Fall through; the onNoteDeleted cascade may have run for some
        // of them; the Postgres rows will be cleaned by the cascade.
      }
    }

    // 4. Remove user's workspace memberships from Postgres.
    try {
      const r = await pgPool().query(
        `DELETE FROM workspace_members WHERE uid = $1`,
        [uid],
      );
      summary.pgMembershipsDeleted = r.rowCount || 0;
    } catch (err) {
      summary.pgErrors++;
      log.error({ err: { message: err?.message } }, 'delete_account_pg_membership_failed');
    }

    // 5. Delete user row in Postgres (cascade-protected — workspaces +
    //    notes already cleaned above).
    try {
      await pgPool().query(`DELETE FROM users WHERE uid = $1`, [uid]);
    } catch (err) {
      // Foreign-key violations possible if a workspace's owner_uid is this user
      // but we couldn't delete the workspace (because of other owners). Log
      // and continue — the auth deletion below still purges the identity.
      summary.pgErrors++;
      log.warn({ err: { message: err?.message } }, 'delete_account_pg_user_failed');
    }

    // 6. Delete Firebase Auth user (last, so token can't be re-used to
    //    re-trigger anything above).
    try {
      await getAuth().deleteUser(uid);
      summary.authDeleted = true;
    } catch (err) {
      // auth/user-not-found = idempotent success; anything else is a real failure.
      if (err?.code === 'auth/user-not-found') {
        summary.authDeleted = true;
      } else {
        log.error({ err: { message: err?.message, code: err?.code } }, 'delete_account_auth_failed');
        return res.status(500).json({ error: 'auth_deletion_failed', summary });
      }
    }

    log.info({ summary }, 'delete_account_complete');
    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    log.error({ err: { message: err?.message }, summary }, 'delete_account_unexpected_failure');
    return res.status(500).json({ error: 'unexpected_failure', summary });
  }
}

module.exports = { handleDeleteAccount };
