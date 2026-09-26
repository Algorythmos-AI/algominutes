'use strict';

// The one way a "ready" or "failed" notice reaches the notifier (A7.3).
//
// The notice itself is a note_notices row, written in the same transaction as
// the outcome it announces (@algominutes/db note-notices.cjs). This enqueues the
// notify task for it after that commit, named after the notice: a second
// enqueue of the same notice (a replayed task, the sweep re-enqueuing one left
// unsent) is dropped by Cloud Tasks as ALREADY_EXISTS. The notifier claims the
// row before sending and marks it sent, so a duplicate delivery sends nothing.
//
// Never throws: it runs after the outcome is committed, and failing to enqueue
// must not undo or mask it. A notice left unsent is re-enqueued by the sweep.

const { createHash } = require('node:crypto');
const cloudTasks = require('./cloud-tasks.cjs');

/**
 * The notify task's id for a notice. Deterministic, so every enqueue of one
 * notice names the same task; led by a hash, because Cloud Tasks slows down on
 * sequential ids (notice ids are a sequence).
 */
function noticeTaskId(noticeId) {
  const id = String(noticeId);
  return `${createHash('sha256').update(`notice:${id}`).digest('hex').slice(0, 12)}-notice-${id}`;
}

/**
 * Enqueue the notify task for `notice` ({ id, noteId, workspaceId, uid, kind }).
 * Returns 'enqueued'; 'already_queued' when a task of that name exists (still
 * live, or ran within the last hour or so: Cloud Tasks reserves the name, so a
 * notice whose task ran out of attempts goes out on a later sweep); 'skipped'
 * (no notifier configured: local and tests); or 'failed' (logged).
 * `traceId` is the recording's.
 */
async function enqueueNotice({ notice, traceId, log: baseLog, enqueueTask = cloudTasks.enqueueTask }) {
  // The repo layer's callers may pass a logger with only error() (or none);
  // every line here still carries the note's user, workspace and note where it
  // can.
  const base = baseLog || require('./logger.cjs').logger;
  // In each line's own fields, not only a child's: a caller's logger may have
  // no child().
  const fields = {
    traceId, userId: notice.uid, workspaceId: notice.workspaceId, noteId: notice.noteId, noticeId: notice.id, type: notice.kind,
  };
  const log = typeof base.child === 'function' ? base.child(fields) : base;
  const targetUrl = process.env.NOTIFIER_URL;
  const projectId = process.env.TASKS_PROJECT;
  const oidcServiceAccount = process.env.JOBS_SA_EMAIL;
  if (!targetUrl || !projectId || !oidcServiceAccount) {
    log.info?.({ ...fields, hasNotifierUrl: !!targetUrl }, 'notify_enqueue_skipped_no_config');
    return 'skipped';
  }
  let existing = false;
  try {
    await enqueueTask({
      projectId,
      location: process.env.TASKS_LOCATION || 'us-central1',
      queue: process.env.NOTIFY_QUEUE || 'notify',
      targetUrl,
      oidcServiceAccount,
      payload: {
        type: notice.kind,
        noteId: notice.noteId,
        workspaceId: notice.workspaceId,
        uid: notice.uid,
        noticeId: String(notice.id),
      },
      taskId: noticeTaskId(notice.id),
      onExisting: () => { existing = true; },
      traceId,
      log,
    });
    if (existing) {
      log.info?.(fields, 'notify_already_queued');
      return 'already_queued';
    }
    log.info?.(fields, 'notify_enqueued');
    return 'enqueued';
  } catch (err) {
    log.error({ err, ...fields }, 'notify_enqueue_failed');
    return 'failed';
  }
}

module.exports = { enqueueNotice, noticeTaskId };
