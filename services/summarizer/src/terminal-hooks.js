'use strict';

// A7.3/A7.4 terminal hooks for the summarizer — the LAST pipeline stage.
//
//   onReady(...)                    → enqueue a `note_ready` notify task.
//   onSummarizeTerminalFailure(...) → dead-letter the exhausted job, refund the
//                                     note's metered minutes, and enqueue a
//                                     `note_failed` notify task.
//
// Everything is BEST-EFFORT and never throws into the caller: on the success
// path a failed notify must not roll back a summary that landed; on the failure
// path a failed DLQ/refund must not mask the original error. The A7.4 repo layer
// (dead_letter, usage_ledger) is reached ONLY through @algominutes/db
// (CLAUDE.md §Data plane), never re-implemented here.

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const sharedTasks = loadShared('cloud-tasks.cjs');
// The note-author read lives in the repo layer, scoped to the task's workspace.
const pipelineRepo = require('@algominutes/db/pipeline-repo.cjs');

let _repoWarned = false;
function requireRepo(basename) {
  const specs = [`@algominutes/db/${basename}.ts`, `@algominutes/db/${basename}`];
  for (const spec of specs) {
    try {
      return require(spec);
    } catch (err) {
      if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')) continue;
      throw err;
    }
  }
  return null;
}

function repoFn(basename, fnName, log) {
  const mod = requireRepo(basename);
  if (mod && typeof mod[fnName] === 'function') return mod[fnName];
  if (!_repoWarned) {
    _repoWarned = true;
    log.warn({ basename, fnName }, 'db_repo_unavailable_skipping');
  }
  return null;
}

async function resolveNoteUid({ pool, noteId, workspaceId, uid, log }) {
  if (uid) return { uid, workspaceId: workspaceId || null };
  try {
    const row = await pipelineRepo.noteAuthor(pool, { noteId, workspaceId });
    if (row) return { uid: row.uid || null, workspaceId: workspaceId || row.workspaceId || null };
  } catch (err) {
    log.error({ err, noteId }, 'note_author_lookup_failed');
  }
  return { uid: uid || null, workspaceId: workspaceId || null };
}

async function recordDeadLetterSafe(input, log) {
  const fn = repoFn('dead-letter-repo', 'recordDeadLetter', log);
  if (!fn) return;
  try {
    const r = await fn(input);
    log.info({ deadLetterId: r && r.id, queue: input.queue, noteId: input.noteId }, 'dead_letter_recorded');
  } catch (err) {
    log.error({ err, queue: input.queue, noteId: input.noteId }, 'dead_letter_record_failed');
  }
}

async function refundSafe(input, log) {
  const fn = repoFn('usage-repo', 'reverseUsageForNote', log);
  if (!fn) return;
  try {
    const r = await fn(input);
    log.info({ noteId: input.noteId, applied: r && r.applied, minutesReversed: r && r.minutesReversed }, 'usage_refunded');
  } catch (err) {
    log.error({ err, noteId: input.noteId }, 'usage_refund_failed');
  }
}

async function enqueueNotify({ type, noteId, workspaceId, uid, traceId, log: baseLog }) {
  const log = baseLog.child({ userId: uid, workspaceId });
  const targetUrl = process.env.NOTIFIER_URL;
  const projectId = process.env.TASKS_PROJECT;
  const oidcServiceAccount = process.env.JOBS_SA_EMAIL;
  const location = process.env.TASKS_LOCATION || 'us-central1';
  const queue = process.env.NOTIFY_QUEUE || 'notify';

  if (!targetUrl || !projectId || !oidcServiceAccount) {
    log.info({ type, noteId, hasNotifierUrl: !!targetUrl }, 'notify_enqueue_skipped_no_config');
    return;
  }
  if (!uid) {
    log.warn({ type, noteId }, 'notify_enqueue_skipped_no_uid');
    return;
  }
  try {
    await sharedTasks.enqueueTask({
      projectId,
      location,
      queue,
      targetUrl,
      oidcServiceAccount,
      payload: { type, noteId, workspaceId, uid },
      traceId,
      log,
    });
    log.info({ type, noteId }, 'notify_enqueued');
  } catch (err) {
    log.error({ err, type, noteId }, 'notify_enqueue_failed');
  }
}

/** SUCCESS: the note is now `ready`. Notify the author. */
async function onReady({ pool, noteId, workspaceId, uid, traceId, log }) {
  if (!noteId) return;
  const resolved = await resolveNoteUid({ pool, noteId, workspaceId, uid, log });
  await enqueueNotify({
    type: 'note_ready',
    noteId,
    workspaceId: resolved.workspaceId,
    uid: resolved.uid,
    traceId,
    log,
  });
}

/** FINAL-ATTEMPT FAILURE: DLQ + refund + notify. `payload` is metadata only. */
async function onSummarizeTerminalFailure({ pool, noteId, workspaceId, uid, err, attempts, traceId, payload, log }) {
  if (!noteId) return;
  const resolved = await resolveNoteUid({ pool, noteId, workspaceId, uid, log });
  await recordDeadLetterSafe({
    queue: 'summarize',
    noteId,
    workspaceId: resolved.workspaceId,
    payload,
    error: err && err.message ? err.message : (err ? String(err) : null),
    attempts: attempts != null ? attempts : null,
    traceId: traceId || null,
  }, log);
  await refundSafe({
    noteId,
    reason: 'refund:summary_failed',
    idempotencyKey: `${noteId}:refund:summarize`,
  }, log);
  await enqueueNotify({
    type: 'note_failed',
    noteId,
    workspaceId: resolved.workspaceId,
    uid: resolved.uid,
    traceId,
    log,
  });
}

module.exports = { onReady, onSummarizeTerminalFailure, enqueueNotify, resolveNoteUid };
