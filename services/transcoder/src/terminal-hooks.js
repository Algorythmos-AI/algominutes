'use strict';

// A7.4 terminal-failure hooks for the transcoder.
//
// When a transcode job fails permanently the note is already being flipped to
// 'error' (note-terminal.cjs). This module ADDS the A7.4 reliability tail:
//   1. dead-letter the exhausted job so it is never silently lost (Cloud Tasks
//      has no native DLQ sink),
//   2. refund the note's metered minutes (a failed recording must not be
//      charged), and
//   3. notify the author that the recording failed.
//
// Everything here is BEST-EFFORT and never throws into the caller's failure
// path — the same discipline as note-terminal.cjs: a failure to record the
// failure must not mask the original error, and these additions must never
// change the behaviour of the existing terminal write.

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

// The A7.4 repo layer (dead_letter, usage_ledger) is authored in TypeScript
// under @algominutes/db and is resolvable at runtime on Node 24 (type-stripping
// + .js→.ts resolution). It must be reached ONLY through the repo layer
// (CLAUDE.md §Data plane) — never re-implemented here. If it cannot be loaded
// (e.g. the Node 22 image before the A11 workspace build lands) we log-and-skip
// rather than crash the pipeline's failure path.
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

/** Author uid for a note, from the job body if present, else from Postgres. */
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

/**
 * Enqueue a `notify` Cloud Task (queue `notify`, target `NOTIFIER_URL`).
 * Where the tasks/notifier config is absent (local/dev) this skips with a log
 * line rather than crashing. Never throws.
 */
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

/**
 * The full A7.4 tail for a permanently-failed transcode: DLQ + refund + notify.
 * `payload` must be job METADATA only (no transcript/PII).
 */
async function onTranscodeTerminalFailure({ pool, noteId, workspaceId, uid, err, attempts, traceId, payload, log }) {
  if (!noteId) return;
  const resolved = await resolveNoteUid({ pool, noteId, workspaceId, uid, log });
  await recordDeadLetterSafe({
    queue: 'transcode',
    noteId,
    workspaceId: resolved.workspaceId,
    payload,
    error: err && err.message ? err.message : (err ? String(err) : null),
    attempts: attempts != null ? attempts : null,
    traceId: traceId || null,
  }, log);
  await refundSafe({
    noteId,
    reason: 'refund:transcode_failed',
    idempotencyKey: `${noteId}:refund:transcode`,
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

module.exports = { onTranscodeTerminalFailure, enqueueNotify, resolveNoteUid };
