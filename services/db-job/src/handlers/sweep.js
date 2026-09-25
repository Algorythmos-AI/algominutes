// services/db-job/src/handlers/sweep.js — the periodic sweeper (plan PR-15).
//
// Cloud Scheduler runs the `db-sweep` Cloud Run Job (the db-job image with
// JOB_NAME=sweep baked in) every 15 minutes. Each step is bounded, idempotent
// and isolated: one failing step is logged and the rest still run, then the
// job exits non-zero so the failure is visible. An advisory lock keeps two
// runs from overlapping (a slow run plus the next tick, or a job retry).
//
//   1. storage purges    retry what note/account deletion couldn't finish
//                        (each note's mirror doc and every object version).
//                        After MAX_PURGE_ATTEMPTS a purge is left and logged as
//                        stuck, for a human (the alert counts it).
//   2. stuck notes       a note in flight with no progress for STUCK_NOTE_MS is
//                        failed and refunded in one transaction (notes-repo
//                        failStuckNote re-checks it at the UPDATE, Postgres
//                        first), then gets a dead letter. The user sees an error
//                        and can retry instead of an endless spinner.
//   3. upload sessions   expired rows are deleted (GCS expires the sessions).
//   4. account deletions a deletion the client never finished (it crashed, or
//                        gave up after a 500) is finished here: the same steps
//                        as the route (account-repo finishAccountDeletion).
//   5. tombstones        completed account deletions, and deleted-note
//                        tombstones (note_tombstones), older than TOMBSTONE_DAYS
//                        are pruned.
//   6. retention         notes older than their author's retention choice
//                        (users.retention_days) are deleted through deleteNote,
//                        the manual-delete path, and purged right away as the
//                        api does (DATA-RETENTION §2). Runs first, so its
//                        purges' retries are the next run's.
//   7. trials            elapsed trials are flipped to free_floor in the stored
//                        state (reads already derive it; this keeps reporting
//                        and the rails' view honest).
//   8. usage_events      paid-work records (the spend cap's input) older than
//                        USAGE_EVENTS_DAYS are pruned; the cap reads 24 hours.
//   9. mirror_repair     a note Postgres finished 10-40 minutes ago whose doc
//                        disagrees (a mirror write lost after its commit) is
//                        brought in line (packages/db mirror-repair.ts).

'use strict';

// The repo layer is TypeScript, loaded under tsx in the job image. Tests pass
// their own (see run's `repo` / `noteTerminal`), so it's required lazily.
const loadRepo = () => require('@algominutes/db');
const loadNoteTerminal = () => require('@algominutes/db/note-terminal.cjs');

const IN_FLIGHT_STALE_MS = 3 * 60 * 60 * 1000; // notes-repo IN_FLIGHT_STALE_MS (asserted equal in tests)
const PURGE_GRACE_MS = 5 * 60 * 1000; // the api runs a new purge inline; leave it that long
const MAX_PURGE_ATTEMPTS = 10;
const STUCK_NOTE_MS = IN_FLIGHT_STALE_MS + 30 * 60 * 1000; // after a client re-queue's chance
const ACCOUNT_DELETION_GRACE_MS = 15 * 60 * 1000; // the client's own retry goes first
const TOMBSTONE_DAYS = 30;
const USAGE_EVENTS_DAYS = 90;
const MIRROR_SETTLED_MS = 10 * 60 * 1000; // past any in-flight mirror write
const MIRROR_WINDOW_MS = 30 * 60 * 1000; // two 15-minute runs see each note
const MIRROR_REPAIR_LIMIT = 200;
const LOCK_KEY = 'algominutes:sweep';

function firebaseDeps(env) {
  const { getApps, initializeApp } = require('firebase-admin/app');
  if (!getApps().length) initializeApp(env.STORAGE_BUCKET ? { storageBucket: env.STORAGE_BUCKET } : undefined);
  return {
    auth: require('firebase-admin/auth').getAuth(),
    firestore: require('firebase-admin/firestore').getFirestore(),
    bucket: require('firebase-admin/storage').getStorage().bucket(),
  };
}

async function openLockClient() {
  const { Client } = require('pg');
  const { buildPgConfig } = require('@algominutes/ai/pg-config.cjs');
  const client = new Client(buildPgConfig());
  await client.connect();
  return client;
}

async function run({
  log, env, traceId, deps: injected, now = new Date(), repo = loadRepo(), noteTerminal = loadNoteTerminal(),
  connectLockClient = null,
}) {
  const deps = injected || firebaseDeps(env);
  const {
    listPendingStoragePurges, listStuckStoragePurges, runStoragePurge, listStuckNotes, failStuckNote,
    recordDeadLetter, deleteExpiredUploadSessions, listIncompleteAccountDeletions,
    finishAccountDeletion, pruneCompletedAccountDeletions, listNotesPastRetention, deleteNote, getStoragePurge,
    expireElapsedTrials, pruneDeletedNotes, pruneUsageEvents, listRecentlyFinishedNotes, repairNoteMirror,
  } = repo;
  void noteTerminal; // kept injectable; stuck notes now fail through the repo layer

  // One sweep at a time: a session-level advisory lock, released when the run
  // ends (or the connection drops). It's held on a DEDICATED connection, outside
  // the repo pool, so the sweep works at any pool cap (PG_POOL_MAX): a lock
  // client taken from a pool of 1 would leave no connection for the sweep's own
  // queries. The connection budget counts it (connection-budget.json).
  const lockClient = connectLockClient ? await connectLockClient() : await openLockClient();
  try {
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS got', [LOCK_KEY]);
    if (!rows[0].got) {
      log.info({}, 'sweep_already_running');
      return { skipped: 'already_running' };
    }
    try {
      return await sweepOnce();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
        .catch((err) => log.error({ err }, 'sweep_unlock_failed'));
    }
  } finally {
    await lockClient.end().catch((err) => log.error({ err }, 'sweep_lock_client_close_failed'));
  }

  async function sweepOnce() {
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

    await step('retention', async () => {
      let deleted = 0;
      let failed = 0;
      for (const n of await listNotesPastRetention({ now, limit: 200 })) {
        const noteLog = log.child({ userId: n.authorUid });
        const fields = { noteId: n.noteId, workspaceId: n.workspaceId };
        try {
          // As the author: deleteNote checks they may delete it.
          const r = await deleteNote(deps.firestore, { noteId: n.noteId, workspaceId: n.workspaceId, uid: n.authorUid, traceId }, noteLog);
          if (!r.allowed) {
            noteLog.warn(fields, 'retention_delete_refused');
            continue;
          }
          deleted += 1;
          // The storage_purges step leaves a fresh purge for PURGE_GRACE_MS, so
          // run it now, as the api's delete route does. A failure stays queued.
          const purge = await getStoragePurge(r.purgeId);
          const purged = purge ? await runStoragePurge({ bucket: deps.bucket, firestore: deps.firestore }, purge, noteLog) : false;
          noteLog.info({ ...fields, purgeId: r.purgeId, purged, createdAt: n.createdAt.toISOString() }, 'note_deleted_retention');
        } catch (err) {
          // One note's failure must not skip the rest of the batch.
          failed += 1;
          noteLog.error({ err, ...fields }, 'retention_delete_failed');
        }
      }
      if (failed) throw new Error(`${failed} retention deletion(s) failed`);
      return deleted;
    });

    await step('storage_purges', async () => {
      let done = 0;
      // Stuck ones are listed separately, so they can never crowd out newer purges.
      for (const p of await listPendingStoragePurges(200, MAX_PURGE_ATTEMPTS)) {
        if (now.getTime() - p.createdAt.getTime() < PURGE_GRACE_MS) continue;
        if (await runStoragePurge({ bucket: deps.bucket, firestore: deps.firestore }, p, log)) done += 1;
      }
      const stuck = await listStuckStoragePurges(50, MAX_PURGE_ATTEMPTS);
      for (const p of stuck) {
        log.error({
          purgeId: p.id, noteId: p.noteId, workspaceId: p.workspaceId,
          ...(p.uid ? { userId: p.uid } : {}), ...(p.traceId ? { traceId: p.traceId } : {}),
          attempts: p.attempts, lastError: p.lastError,
        }, 'storage_purge_stuck');
      }
      return { done, stuck: stuck.length };
    });

    await step('stuck_notes', async () => {
      const stuck = await listStuckNotes({ olderThanMs: STUCK_NOTE_MS, limit: 100 });
      let failed = 0;
      for (const n of stuck) {
        const fields = { noteId: n.noteId, workspaceId: n.workspaceId, userId: n.authorUid };
        const noteLog = log.child({ userId: n.authorUid });
        // Re-checked at the UPDATE: a note that moved on since the listing is left
        // alone, with no dead letter and no refund.
        const r = await failStuckNote(deps.firestore, {
          noteId: n.noteId,
          workspaceId: n.workspaceId,
          olderThanMs: STUCK_NOTE_MS,
          message: 'Processing took too long and was stopped. Please try again.',
          // Written in the failure's transaction, under the note's row lock.
          refund: { reason: 'refund:stuck', idempotencyKey: `${n.noteId}:refund:stuck` },
        }, noteLog);
        if (!r.failed) continue;
        failed += 1;
        noteLog.error({ noteId: n.noteId, workspaceId: n.workspaceId, status: n.status }, 'note_failed_stuck');
        await recordDeadLetter({
          queue: 'sweep',
          noteId: n.noteId,
          workspaceId: n.workspaceId,
          payload: { reason: 'stuck_in_flight', status: n.status, updatedAt: n.updatedAt.toISOString() },
          error: 'stuck_in_flight',
          attempts: null,
          traceId,
        }).catch((err) => log.error({ err, ...fields }, 'sweep_dead_letter_failed'));
      }
      return failed;
    });

    // A finished note whose doc missed its mirror write (packages/db
    // mirror-repair.ts): checked twice while 10-40 minutes old, repaired only
    // if Postgres says finished and the doc hasn't moved since it was read.
    await step('mirror_repair', async () => {
      const notes = await listRecentlyFinishedNotes({ settledMs: MIRROR_SETTLED_MS, windowMs: MIRROR_WINDOW_MS, limit: MIRROR_REPAIR_LIMIT });
      // Oldest first, so at the limit the newest of this window wait for the
      // next run, and some may age out unchecked.
      if (notes.length === MIRROR_REPAIR_LIMIT) log.warn({ limit: MIRROR_REPAIR_LIMIT }, 'mirror_repair_limit_reached');
      let repaired = 0;
      let failedRepairs = 0;
      for (const n of notes) {
        const fields = { noteId: n.noteId, workspaceId: n.workspaceId };
        try {
          const outcome = await repairNoteMirror(deps.firestore, n, { settledMs: MIRROR_SETTLED_MS });
          if (outcome === 'repaired') {
            repaired += 1;
            log.warn({ ...fields, status: n.status }, 'mirror_repaired');
          }
        } catch (err) {
          failedRepairs += 1;
          log.error({ err, ...fields }, 'mirror_repair_failed');
        }
      }
      if (failedRepairs) throw new Error(`${failedRepairs} mirror repair(s) failed`);
      return repaired;
    });

    await step('upload_sessions', () => deleteExpiredUploadSessions(now));

    await step('account_deletions', async () => {
      let finished = 0;
      let incomplete = 0;
      for (const d of await listIncompleteAccountDeletions({ olderThanMs: ACCOUNT_DELETION_GRACE_MS, limit: 50 })) {
        // Logged under the original request's traceId, so the finish traces back to it.
        const accountLog = log.child({ userId: d.uid, ...(d.traceId ? { traceId: d.traceId } : {}) });
        try {
          const r = await finishAccountDeletion(deps, d, accountLog);
          if (r.complete) finished += 1;
          else incomplete += 1;
        } catch (err) {
          // One account's failure must not skip the rest of the batch.
          incomplete += 1;
          accountLog.error({ err }, 'sweep_account_deletion_failed');
        }
      }
      if (incomplete) throw new Error(`${incomplete} account deletion(s) still incomplete`);
      return finished;
    });

    await step('tombstones', () => pruneCompletedAccountDeletions({ olderThanDays: TOMBSTONE_DAYS }));
    await step('note_tombstones', () => pruneDeletedNotes({ olderThanDays: TOMBSTONE_DAYS }));

    await step('trials', () => expireElapsedTrials());
    await step('usage_events', () => pruneUsageEvents({ olderThanDays: USAGE_EVENTS_DAYS }));

    log.info({ counts, failures }, 'sweep_done');
    if (failures.length) throw new Error(`sweep: ${failures.join(', ')} failed`);
    return counts;
  }
}

module.exports = { run, STUCK_NOTE_MS, MAX_PURGE_ATTEMPTS, PURGE_GRACE_MS, IN_FLIGHT_STALE_MS };
