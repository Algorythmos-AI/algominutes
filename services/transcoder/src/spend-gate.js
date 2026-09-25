'use strict';

// §4.6 spend circuit breaker, before the paid speech a kickoff starts. At the
// cap a note still 'queued' (nothing paid for yet) is failed, Postgres first,
// refunded and its author told (spend-guard haltAtSpendCap). A kickoff replayed
// mid-run carries on: its speech is partly paid for, and failing it would waste
// that. A poll task only checks a job already paid for, so it isn't gated.
//
// Returns the response to send, or null to carry on.
async function spendGate(body, { db, mirror, log, traceId, terminalHooks, noteTerminal, spendGuard }) {
  if (!body || body.kind !== 'kickoff') return null;
  const { noteId, workspaceId } = body;
  return spendGuard.haltAtSpendCap({
    log, noteId, workspaceId,
    markFailed: () => noteTerminal.markNoteFailed({
      pool: db.pool(), firestore: mirror.db(), noteId, workspaceId,
      message: spendGuard.SPEND_CAP_MESSAGE, log, event: 'spend_cap_note_failed',
      retryOnPgError: true, onlyIfStatus: ['queued'],
    }),
    onCapped: (err) => terminalHooks.onTranscodeTerminalFailure({
      pool: db.pool(), noteId, workspaceId, err, attempts: null, traceId,
      payload: {
        kind: body.kind, type: body.type, noteId, workspaceId,
        storagePath: body.storagePath, sourceUrl: body.sourceUrl, mimeType: body.mimeType,
      },
      log,
      refundReason: 'refund:spend_cap',
    }),
  });
}

module.exports = { spendGate };
