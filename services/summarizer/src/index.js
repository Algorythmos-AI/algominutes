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
const sharedRedaction = loadShared('redaction.cjs');
const sharedTemplates = loadShared('summary-templates.cjs');
const sharedIntelligence = loadShared('intelligence.cjs');
const noteTerminal = loadShared('note-terminal.cjs');
const geminiCall = loadShared('gemini-call.cjs');
const spendGuard = loadShared('spend-guard.cjs');
const handler = require('./handler');

const app = express();
app.use(express.json({ limit: '64kb' }));

const env = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
};

const rootLog = sharedLogger.logger.child({ svc: 'summarizer' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const traceId = sharedLogger.traceIdFrom(req.headers);
  const log = rootLog.child({ traceId, noteId: req.body && req.body.noteId });

  // §4.6 spend circuit breaker — halt before the paid Gemini call if today's
  // spend hit the daily cap.
  try {
    await spendGuard.assertUnderDailyCap({ log });
  } catch (err) {
    if (err && err.code === 'SPEND_CAP_EXCEEDED') {
      log.error({ err }, 'spend_cap_tripped_pipeline_halted');
      // Ack (200) so Cloud Tasks does not retry-storm while capped.
      // TODO(A9): mark the note 'deferred', re-drive on reset, refund minutes (A7.4).
      return res.status(200).json({ ok: false, deferred: true, reason: 'spend_cap' });
    }
    throw err;
  }

  try {
    await handler.handle(req.body || {}, {
      log,
      env,
      sharedIntelligence,
      sharedTemplates,
      sharedRedaction,
      geminiCall,
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ err }, 'summarizer_task_failed');
    // Cloud Tasks retries this and then DROPS the task — the queue is created
    // with --max-attempts=5 and no dead-letter topic, so there is no sink and
    // nothing to inspect afterwards. This terminal write is the only record.
    // Without a terminal write the note sits at 'summarizing' forever: there
    // is no server-side sweeper, and the client watchdog only ticks while the
    // app is foregrounded. Mark it failed on the LAST attempt only, so genuine
    // transient failures still get their retries.
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
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'summarizer_started'));
