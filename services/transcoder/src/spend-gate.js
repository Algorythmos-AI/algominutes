'use strict';

// §4.6 spend circuit breaker, before the paid speech a kickoff starts. At the
// cap the note is failed (Postgres first), refunded and its author told
// (spend-guard haltAtSpendCap). A poll task only checks a job already paid for:
// stopping it would waste that spend and strand the note, so it isn't gated.
//
// Returns the response to send, or null to carry on.
async function spendGate(body, { db, mirror, log, traceId, terminalHooks, noteTerminal, spendGuard }) {
  if (!body || body.kind !== 'kickoff') return null;
  const { noteId, workspaceId } = body;
  return spendGuard.haltAtSpendCap({
    log, noteId, workspaceId,
    markFailed: () => noteTerminal.markNoteFailed({
      pool: db.pool(), firestore: mirror.db(), noteId, workspaceId,
      message: spendGuard.SPEND_CAP_MESSAGE, log, event: 'spend_cap_note_failed', retryOnPgError: true,
    }),
    onCapped: (err) => terminalHooks.onTranscodeTerminalFailure({
      pool: db.pool(), noteId, workspaceId, err, attempts: null, traceId,
      payload: {
        kind: body.kind, type: body.type, noteId, workspaceId,
        storagePath: body.storagePath, sourceUrl: body.sourceUrl, mimeType: body.mimeType,
      },
      log,
    }),
  });
}

module.exports = { spendGate };
