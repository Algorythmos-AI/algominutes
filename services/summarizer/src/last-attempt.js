'use strict';

// The queue's last attempt at a summary that kept throwing: fail the note
// (Postgres first), then dead-letter the job, refund the note's minutes and
// tell its author. The refund runs for any note Postgres has failed (it's
// net-guarded); the notice only for a new failure, so the author is told once.
// A note that is ready anyway (the attempt threw after markSummaryReady
// committed) gets the dead letter alone, as does one Postgres couldn't be
// asked about. A note that is gone gets nothing.
//
// A regeneration (its task carries the summaryGeneration the api claimed)
// isn't refunded: the recording was transcribed and summarised once, and that
// run's charge stands. Refunding it gave the whole recording back for a
// failed re-summary, and the next regeneration left it ready at net 0.
async function onLastAttempt({ body, headers, err, markNoteFailed, terminalHooks, pool, log, traceId }) {
  const b = body || {};
  const { noteId, workspaceId } = b;
  const { failed, marked, pgErrored, exists } = await markNoteFailed({
    noteId, workspaceId,
    message: 'We could not write a summary for this recording.',
    log,
  });
  const deadLetterOnly = !marked;
  if (deadLetterOnly && !(exists || pgErrored)) {
    log.warn({ noteId, workspaceId, reason: 'note_gone' }, 'summarizer_last_attempt_hooks_skipped');
    return { failed };
  }
  if (deadLetterOnly) {
    log.warn({ noteId, workspaceId, reason: pgErrored ? 'postgres_error' : 'note_not_failed' }, 'summarizer_last_attempt_dead_letter_only');
  }
  const attempts = Number((headers && headers['x-cloudtasks-taskretrycount']) || 0) + 1;
  const regeneration = b.summaryGeneration !== undefined && b.summaryGeneration !== null;
  await terminalHooks.onSummarizeTerminalFailure({
    pool: pool(),
    noteId,
    workspaceId,
    err,
    attempts,
    traceId,
    payload: { kind: 'summarize', noteId, workspaceId, template: b.template, summaryGeneration: b.summaryGeneration },
    log,
    deadLetterOnly,
    notify: failed,
    refund: !regeneration,
  });
  return { failed };
}

module.exports = { onLastAttempt };
