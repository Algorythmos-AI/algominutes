'use strict';

// A7.4 terminal-failure hooks for the transcoder.
//
// When a transcode job fails permanently the note is already flipped to
// 'error', its minutes refunded and its "failed" notice written, all in the
// failure's own write (note-terminal.cjs markNoteFailed, with `refund`:
// transcodeRefund below). This module ADDS the rest of the A7.4 tail: the dead
// letter for the exhausted job, so it is never silently lost (Cloud Tasks has
// no native DLQ sink).
//
// Everything here is BEST-EFFORT and never throws into the caller's failure
// path — the same discipline as note-terminal.cjs: a failure to record the
// failure must not mask the original error, and these additions must never
// change the behaviour of the existing terminal write.

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

/**
 * The A7.4 tail for a permanently-failed transcode: the dead letter (the
 * refund and the "failed" notice are markNoteFailed's).
 * `payload` must be job METADATA only (no transcript/PII).
 */
async function onTranscodeTerminalFailure({ pool, noteId, workspaceId, uid, err, attempts, traceId, payload, log, deadLetterOnly = false }) {
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
  // Work lost on a note that isn't failed (ready anyway, or Postgres couldn't
  // say): the dead letter is the only record of it.
  if (deadLetterOnly) log.warn({ traceId, userId: resolved.uid, noteId, workspaceId: resolved.workspaceId }, 'transcode_dead_letter_note_not_failed');
}

/**
 * The refund every transcoder failure passes to markNoteFailed, which writes it
 * in the failure's transaction. One key per run (ledger-reversal.cjs suffixes
 * the debit). 'refund:spend_cap' labels a note the cap stopped before any paid
 * work.
 */
function transcodeRefund(noteId, reason = 'refund:transcode_failed') {
  return { reason, idempotencyKey: `${noteId}:refund:transcode` };
}

module.exports = { onTranscodeTerminalFailure, resolveNoteUid, transcodeRefund };
