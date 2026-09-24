// services/db-job/src/handlers/sweep.js — the periodic sweeper (plan PR-15).
//
// Cloud Scheduler runs `db-job` with JOB_NAME=sweep every 15 minutes. Each
// step is bounded, idempotent and isolated: one failing step is logged and
// the rest still run, then the job exits non-zero so the failure is visible.
//
//   1. storage purges    retry what note/account deletion couldn't finish
//                        (each note's mirror doc and every object version).
//                        After MAX_PURGE_ATTEMPTS a purge is left and logged as
//                        stuck, for a human (the alert counts it).
//   2. stuck notes       a note in flight with no progress for STUCK_NOTE_MS is
//                        failed, Postgres first (note-terminal), then gets a dead
//                        letter and its minutes refunded. The user sees an error
//                        and can retry instead of an endless spinner.
//   3. upload sessions   expired rows are deleted (GCS expires the sessions).
//   4. account deletions a deletion the client never finished (it crashed, or
//                        gave up after a 500) is finished here: the same steps
//                        as the route (account-repo finishAccountDeletion).
//   5. tombstones        completed ones older than TOMBSTONE_DAYS are pruned.

'use strict';

// The repo layer is TypeScript, loaded under tsx in the job image. Tests pass
// their own (see run's `repo` / `noteTerminal`), so it's required lazily.
const loadRepo = () => require('@algominutes/db');
const loadNoteTerminal = () => require('@algominutes/ai/note-terminal.cjs');

const IN_FLIGHT_STALE_MS = 3 * 60 * 60 * 1000; // notes-repo IN_FLIGHT_STALE_MS (asserted equal in tests)
const PURGE_GRACE_MS = 5 * 60 * 1000; // the api runs a new purge inline; leave it that long
const MAX_PURGE_ATTEMPTS = 10;
const STUCK_NOTE_MS = IN_FLIGHT_STALE_MS + 30 * 60 * 1000; // after a client re-queue's chance
const ACCOUNT_DELETION_GRACE_MS = 15 * 60 * 1000; // the client's own retry goes first
const TOMBSTONE_DAYS = 30;

function firebaseDeps(env) {
  const { getApps, initializeApp } = require('firebase-admin/app');
  if (!getApps().length) initializeApp(env.STORAGE_BUCKET ? { storageBucket: env.STORAGE_BUCKET } : undefined);
  return {
    auth: require('firebase-admin/auth').getAuth(),
    firestore: require('firebase-admin/firestore').getFirestore(),
    bucket: require('firebase-admin/storage').getStorage().bucket(),
  };
}

async function run({ log, env, traceId, deps: injected, now = new Date(), repo = loadRepo(), noteTerminal = loadNoteTerminal() }) {
  const deps = injected || firebaseDeps(env);
  const {
    getPool, listPendingStoragePurges, runStoragePurge, listStuckNotes, recordDeadLetter, reverseUsageForNote,
    deleteExpiredUploadSessions, listIncompleteAccountDeletions, finishAccountDeletion, pruneCompletedAccountDeletions,
  } = repo;
  const { markNoteFailed } = noteTerminal;
  const counts = {};
  const failures = [];
  const step = async (name, fn) => {
    try {
      counts[name] = await fn();
    } catch (err) {
      failures.push(name);
      log.error({ err, step: name }, 'sweep_step_failed');
    }
  };

  await step('storage_purges', async () => {
    let done = 0;
    let stuck = 0;
    for (const p of await listPendingStoragePurges(200)) {
      if (now.getTime() - p.createdAt.getTime() < PURGE_GRACE_MS) continue;
      if (p.attempts >= MAX_PURGE_ATTEMPTS) {
        stuck += 1;
        log.error({ purgeId: p.id, noteId: p.noteId, workspaceId: p.workspaceId, attempts: p.attempts, lastError: p.lastError }, 'storage_purge_stuck');
        continue;
      }
      if (await runStoragePurge({ bucket: deps.bucket, firestore: deps.firestore }, p, log)) done += 1;
    }
    return { done, stuck };
  });

  await step('stuck_notes', async () => {
    const stuck = await listStuckNotes({ olderThanMs: STUCK_NOTE_MS, limit: 100 });
    for (const n of stuck) {
      const fields = { noteId: n.noteId, workspaceId: n.workspaceId };
      await markNoteFailed({
        pool: getPool(),
        firestore: deps.firestore,
        noteId: n.noteId,
        workspaceId: n.workspaceId,
        message: 'Processing took too long and was stopped. Please try again.',
        log,
        event: 'sweep_stuck_note',
      });
      await recordDeadLetter({
        queue: 'sweep',
        noteId: n.noteId,
        workspaceId: n.workspaceId,
        payload: { reason: 'stuck_in_flight', status: n.status, updatedAt: n.updatedAt.toISOString() },
        error: 'stuck_in_flight',
        attempts: null,
        traceId,
      }).catch((err) => log.error({ err, ...fields }, 'sweep_dead_letter_failed'));
      await reverseUsageForNote({ noteId: n.noteId, reason: 'refund:stuck', idempotencyKey: `${n.noteId}:refund:stuck` })
        .catch((err) => log.error({ err, ...fields }, 'sweep_refund_failed'));
    }
    return stuck.length;
  });

  await step('upload_sessions', () => deleteExpiredUploadSessions(now));

  await step('account_deletions', async () => {
    let finished = 0;
    let incomplete = 0;
    for (const d of await listIncompleteAccountDeletions({ olderThanMs: ACCOUNT_DELETION_GRACE_MS, limit: 50 })) {
      const r = await finishAccountDeletion(deps, d, log.child({ userId: d.uid }));
      if (r.complete) finished += 1;
      else incomplete += 1;
    }
    if (incomplete) throw new Error(`${incomplete} account deletion(s) still incomplete`);
    return finished;
  });

  await step('tombstones', () => pruneCompletedAccountDeletions({ olderThanDays: TOMBSTONE_DAYS }));

  log.info({ counts, failures }, 'sweep_done');
  if (failures.length) throw new Error(`sweep: ${failures.join(', ')} failed`);
  return counts;
}

module.exports = { run, STUCK_NOTE_MS, MAX_PURGE_ATTEMPTS, PURGE_GRACE_MS, IN_FLIGHT_STALE_MS };
