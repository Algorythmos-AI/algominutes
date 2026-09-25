'use strict';

const express = require('express');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const sharedLogger = loadShared('logger.cjs');
const { requireEnv } = loadShared('require-env.cjs');
requireEnv(
  'summarizer',
  {
    exact: { WRITE_POSTGRES: 'true' },
    oneOf: [
      { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
    ],
  },
  { logger: sharedLogger.logger },
);
const sharedRedaction = loadShared('redaction.cjs');
const sharedTemplates = loadShared('summary-templates.cjs');
const sharedIntelligence = loadShared('intelligence.cjs');
const noteTerminal = loadShared('note-terminal.cjs');
const geminiCall = loadShared('gemini-call.cjs');
const spendGuard = loadShared('spend-guard.cjs');
const spendRepo = loadShared('spend-repo.cjs');
const handler = require('./handler');
const terminalHooks = require('./terminal-hooks');

// §4.6: the daily cap reads the minutes debited in the last 24 hours.
spendGuard.setDailySpendReader(spendRepo.createLedgerSpendReader({ pool: () => handler.pool() }));

const app = express();
app.use(express.json({ limit: '64kb' }));

const env = {
};

const rootLog = sharedLogger.logger.child({ svc: 'summarizer' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  // The enqueuer's traceId, carried in the task body (CLAUDE.md §1).
  const traceId = sharedLogger.traceIdFromTask(req.body, req.headers);
  const log = rootLog.child({
    traceId,
    noteId: req.body && req.body.noteId,
    workspaceId: req.body && req.body.workspaceId,
    userId: req.body && req.body.uid,
  });

  // §4.6 spend circuit breaker — halt before the paid Gemini call if today's
  // spend hit the daily cap. At the cap the note is failed, refunded and its
  // author told (spend-guard haltAtSpendCap), instead of dropped.
  {
    const b = req.body || {};
    const { noteId, workspaceId } = b;
    const halted = await spendGuard.haltAtSpendCap({
      log, noteId, workspaceId,
      markFailed: () => handler.markNoteFailed({
        noteId, workspaceId, message: spendGuard.SPEND_CAP_MESSAGE, log, retryOnPgError: true,
      }),
      onCapped: (err) => terminalHooks.onSummarizeTerminalFailure({
        pool: handler.pool(), noteId, workspaceId, err, attempts: null, traceId,
        payload: { kind: 'summarize', noteId, workspaceId, template: b.template, summaryGeneration: b.summaryGeneration },
        log,
      }),
    });
    if (halted) return res.status(halted.status).json(halted.body);
  }

  try {
    await handler.handle(req.body || {}, {
      log,
      env,
      traceId,
      sharedIntelligence,
      sharedTemplates,
      sharedRedaction,
      geminiCall,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ err }, 'summarizer_task_failed');
    // Cloud Tasks retries this, then drops it after the queue's max attempts.
    // Mark the note failed on the LAST attempt only, so genuine transient
    // failures still get their retries; the hooks below dead-letter, refund and
    // notify. Without it the note would sit at 'summarizing' until the
    // stuck-note sweep (db-job, 3.5 h).
    //
    // The 0-based X-CloudTasks-TaskRetryCount check lives in shared/ now, so
    // the transcoder and this service cannot disagree about which attempt is
    // the last one.
    const { noteId, workspaceId } = req.body || {};
    if (noteTerminal.isFinalAttempt(req.headers) && noteId && workspaceId) {
      await handler.markNoteFailed({
        noteId, workspaceId,
        message: 'We could not write a summary for this recording.',
        log,
      });
      // A7.4 tail: dead-letter the exhausted summarize job, refund the note's
      // metered minutes, and notify the author of the failure. Best-effort —
      // never masks the original error.
      const attempts = Number((req.headers && req.headers['x-cloudtasks-taskretrycount']) || 0) + 1;
      const b = req.body || {};
      await terminalHooks.onSummarizeTerminalFailure({
        pool: handler.pool(),
        noteId,
        workspaceId,
        err,
        attempts,
        traceId,
        payload: { kind: 'summarize', noteId, workspaceId, template: b.template, summaryGeneration: b.summaryGeneration },
        log,
      });
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'summarizer_started'));
