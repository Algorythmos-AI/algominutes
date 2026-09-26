'use strict';

const { transcodeRefund } = require('./terminal-hooks');

// The queue's last attempt at a task that kept throwing: fail the note (both
// stores, Postgres first), then dead-letter the job, refund the note's minutes
// and tell its author. The refund runs for any note Postgres has failed, in
// the failure's own transaction (net-guarded, so a note already failed and
// refunded changes nothing). The "failed" notice is markNoteFailed's, written
// with the failure only when this write is what failed it, so the author is
// told once.
// A note that is ready anyway (the attempt threw after its commit, e.g. an
// embedder enqueue) gets the dead letter alone, the one lasting record that
// work was lost, as does one Postgres couldn't be asked about. A note that is
// gone gets nothing.
//
// A poll task's chunk fails with its note, as at the poll's own terminals, and
// its dead letter keeps the chunk, job and poll count, so the admin view says
// which part of the recording was lost.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function onLastAttempt({ body, headers, err, noteTerminal, terminalHooks, db, mirror, log, traceId }) {
  const b = body || {};
  const { noteId, workspaceId } = b;
  // Only a well-formed id: a malformed one would fail the whole statement.
  const chunkId = b.kind === 'stt-poll' && typeof b.chunkId === 'string' && UUID.test(b.chunkId) ? b.chunkId : null;
  const { failed, marked, pgErrored, exists } = await noteTerminal.markNoteFailed({
    refund: transcodeRefund(noteId),
    chunkId,
    pool: db.pool(),
    firestore: mirror.db(),
    noteId,
    workspaceId,
    message: 'We could not process this recording.',
    log,
    event: 'transcoder_mark_failed',
    traceId,
  });
  const missingIds = !noteId || !workspaceId;
  const deadLetterOnly = !marked;
  if (deadLetterOnly && !(exists || pgErrored || missingIds)) {
    log.warn({ noteId, workspaceId, reason: 'note_gone' }, 'transcoder_last_attempt_hooks_skipped');
    return { failed };
  }
  if (deadLetterOnly) {
    const reason = pgErrored ? 'postgres_error' : missingIds ? 'missing_ids' : 'note_not_failed';
    log.warn({ noteId, workspaceId, reason }, 'transcoder_last_attempt_dead_letter_only');
  }
  // A7.4 tail. Best-effort: never masks the original failure. Transcoder
  // SUCCESS is not terminal (the pipeline continues to summarize), so there is
  // no note_ready here.
  const attempts = Number((headers && headers['x-cloudtasks-taskretrycount']) || 0) + 1;
  await terminalHooks.onTranscodeTerminalFailure({
    pool: db.pool(),
    noteId,
    workspaceId,
    err,
    attempts,
    traceId,
    payload: {
      kind: b.kind, type: b.type, noteId, workspaceId, storagePath: b.storagePath, sourceUrl: b.sourceUrl, mimeType: b.mimeType,
      ...(b.kind === 'stt-poll' ? { chunkId: b.chunkId, jobId: b.jobId, poll: b.poll } : {}),
    },
    log,
    deadLetterOnly,
  });
  return { failed };
}

module.exports = { onLastAttempt };
