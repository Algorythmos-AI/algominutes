'use strict';

// A7.4 terminal hooks for the summarizer — the LAST pipeline stage.
//
//   onSummarizeTerminalFailure(...) → dead-letter the exhausted job. The refund
//                                     and the "failed" notice are written with
//                                     the failure (markNoteFailed, with `refund`:
//                                     summaryRefund below), and the "ready"
//                                     notice with the summary (markSummaryReady).
//
// BEST-EFFORT, and never throws into the caller: a failed DLQ must not mask the
// original error. The A7.4 repo layer
// (dead_letter) is reached ONLY through @algominutes/db
// (CLAUDE.md §Data plane), never re-implemented here.

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

/**
 * FINAL-ATTEMPT FAILURE: the dead letter. The refund and the "failed" notice
 * are markNoteFailed's, written with the failure. `payload` is metadata only.
 */
async function onSummarizeTerminalFailure({ pool, noteId, workspaceId, uid, err, attempts, traceId, payload, log, deadLetterOnly = false }) {
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
  // Work lost on a note that isn't failed (ready anyway, or Postgres couldn't
  // say): the dead letter is the only record of it.
  if (deadLetterOnly) log.warn({ traceId, userId: resolved.uid, noteId, workspaceId: resolved.workspaceId }, 'summarize_dead_letter_note_not_failed');
}

/** The refund a summary failure passes to markNoteFailed (its transaction). */
function summaryRefund(noteId) {
  return { reason: 'refund:summary_failed', idempotencyKey: `${noteId}:refund:summarize` };
}

module.exports = { onSummarizeTerminalFailure, resolveNoteUid, summaryRefund };
