'use strict';

// Entry point. Cloud Tasks pushes a JSON body to POST /; we ack 2xx
// after the work is done (or after a self-reschedule for stt-poll).
// IAM is enforced by Cloud Run via --no-allow-unauthenticated; this
// process trusts that the request reached it.

const express = require('express');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const sharedLogger = loadShared('logger.cjs');
const noteTerminal = loadShared('note-terminal.cjs');
const spendGuard = loadShared('spend-guard.cjs');
const handler = require('./handler');
const db = require('./db');
const storage = require('./storage');
const ffmpeg = require('./ffmpeg');
const youtube = require('./youtube');
const stt = require('./stt');
const mirror = require('./firestore-mirror');
const fastPath = require('./fast-path');
const tasksClient = require('./tasks-client');
const terminalHooks = require('./terminal-hooks');

const app = express();
app.use(express.json({ limit: '256kb' }));

const env = {
  GCS_BUCKET: process.env.GCS_BUCKET || '',
  STT_RECOGNIZER: process.env.STT_RECOGNIZER || '',
  TASKS_PROJECT: process.env.TASKS_PROJECT || '',
  TASKS_LOCATION: process.env.TASKS_LOCATION || 'us-central1',
  TASKS_QUEUE: process.env.TASKS_QUEUE || 'audio-jobs',
  JOBS_SA_EMAIL: process.env.JOBS_SA_EMAIL || '',
  TRANSCODER_URL: process.env.TRANSCODER_URL || '',
  SUMMARIZER_URL: process.env.SUMMARIZER_URL || '',
  EMBEDDER_URL: process.env.EMBEDDER_URL || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  LANGUAGE_CODES: process.env.LANGUAGE_CODES || 'en-US,en-GB,en-AU',
};

const rootLog = sharedLogger.logger.child({ svc: 'transcoder' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const traceId = sharedLogger.traceIdFrom(req.headers);
  const log = rootLog.child({ traceId, kind: req.body && req.body.kind, jobId: req.body && req.body.jobId });

  // §4.6 spend circuit breaker — this is the pipeline entry and the priciest
  // stage (paid STT). Halt before spending if today's cost hit the daily cap.
  try {
    await spendGuard.assertUnderDailyCap({ log });
  } catch (err) {
    if (err && err.code === 'SPEND_CAP_EXCEEDED') {
      log.error({ err }, 'spend_cap_tripped_pipeline_halted');
      // Ack (200) so Cloud Tasks does not retry-storm while capped.
      // TODO(A9): mark the note 'deferred', re-drive when spend resets, and
      // refund metered minutes (A7.4) rather than silently dropping the task.
      return res.status(200).json({ ok: false, deferred: true, reason: 'spend_cap' });
    }
    throw err;
  }

  const tasks = tasksClient.makeClient({ env, log });
  // traceId is threaded into deps so the in-handler terminal paths (STT
  // exhaustion / errors, YouTube permanent failures) can propagate it across
  // the notify hop and onto the dead-letter row (CLAUDE.md §2 propagation).
  const deps = { db, storage, ffmpeg, youtube, stt, mirror, fastPath, tasks, log, env, traceId, terminalHooks };

  try {
    await handler.handle(req.body || {}, deps);
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.error({ err }, 'transcoder_task_failed');
    // Surface 500 so Cloud Tasks retries per the queue's backoff policy.
    //
    // On the LAST attempt, write a terminal state to Postgres as well as
    // Firestore. Without this the note sat at 'queued'/'chunking'/'transcribing'
    // forever: mirrorError writes Firestore only, /api/note serves the Postgres
    // status, and the iOS app therefore showed a spinner that could never
    // resolve. There is no server-side sweeper to catch it, and the queue has
    // no dead-letter sink, so this log line is the only trace a human gets.
    const { noteId, workspaceId } = req.body || {};
    if (noteTerminal.isFinalAttempt(req.headers)) {
      await noteTerminal.markNoteFailed({
        pool: db.pool(),
        firestore: mirror.db(),
        noteId,
        workspaceId,
        message: 'We could not process this recording.',
        log,
        event: 'transcoder_mark_failed',
      });
      // A7.4 tail: dead-letter the exhausted job, refund the note's metered
      // minutes, and notify the author. Best-effort — never masks the original
      // failure. Transcoder SUCCESS is not terminal (the pipeline continues to
      // summarize), so there is no note_ready here.
      const attempts = Number((req.headers && req.headers['x-cloudtasks-taskretrycount']) || 0) + 1;
      const b = req.body || {};
      await terminalHooks.onTranscodeTerminalFailure({
        pool: db.pool(),
        noteId,
        workspaceId,
        err,
        attempts,
        traceId,
        payload: { kind: b.kind, type: b.type, noteId, workspaceId, storagePath: b.storagePath, sourceUrl: b.sourceUrl, mimeType: b.mimeType },
        log,
      });
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  rootLog.info({ port }, 'transcoder_started');
});
