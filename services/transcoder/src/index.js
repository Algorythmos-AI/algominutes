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
const { requireEnv } = loadShared('require-env.cjs');
requireEnv(
  'transcoder',
  {
    exact: { WRITE_POSTGRES: 'true' },
    oneOf: [
      { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
    ],
  },
  { logger: sharedLogger.logger },
);
const noteTerminal = loadShared('note-terminal.cjs');
const spendGuard = loadShared('spend-guard.cjs');
const spendRepo = loadShared('spend-repo.cjs');
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
const { spendGate } = require('./spend-gate');
const { onLastAttempt } = require('./last-attempt');

// §4.6: the daily cap reads the audio minutes sent to paid work in the last 24 hours.
spendGuard.setDailySpendReader(spendRepo.createPaidWorkSpendReader({ pool: () => db.pool() }));

const app = express();
app.use(express.json({ limit: '256kb' }));

const env = {
  GCS_BUCKET: process.env.GCS_BUCKET || '',
  STT_RECOGNIZER: process.env.STT_RECOGNIZER || '',
  TASKS_PROJECT: process.env.TASKS_PROJECT || '',
  TASKS_LOCATION: process.env.TASKS_LOCATION || 'us-central1',
  // Per-stage queues (Terraform-created names). Defaults match the module.
  TRANSCODE_QUEUE: process.env.TRANSCODE_QUEUE || 'transcode',
  SUMMARIZE_QUEUE: process.env.SUMMARIZE_QUEUE || 'summarize',
  EMBED_QUEUE: process.env.EMBED_QUEUE || 'embed',
  JOBS_SA_EMAIL: process.env.JOBS_SA_EMAIL || '',
  TRANSCODER_URL: process.env.TRANSCODER_URL || '',
  SUMMARIZER_URL: process.env.SUMMARIZER_URL || '',
  EMBEDDER_URL: process.env.EMBEDDER_URL || '',
  LANGUAGE_CODES: process.env.LANGUAGE_CODES || 'en-US,en-GB,en-AU',
  // Long-path STT engine seam. Default 'google' keeps the legacy per-chunk path
  // (shadow-eval baseline / a1 fallback). Flip to 'assemblyai' after the shadow
  // eval clears cutover; 'deepgram' is the failover (⚠️ exceeds Pro net revenue
  // at the cap — see docs/DECISIONS.md "Diarisation"). Keys come from Secret
  // Manager, never the repo.
  STT_PROVIDER: process.env.STT_PROVIDER || 'google',
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY || '',
  ASSEMBLYAI_BASE_URL: process.env.ASSEMBLYAI_BASE_URL || '',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
  DEEPGRAM_BASE_URL: process.env.DEEPGRAM_BASE_URL || '',
  DEEPGRAM_MODEL: process.env.DEEPGRAM_MODEL || '',
};

const rootLog = sharedLogger.logger.child({ svc: 'transcoder' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  // The enqueuer's traceId, carried in the task body (CLAUDE.md §1).
  const traceId = sharedLogger.traceIdFromTask(req.body, req.headers);
  const log = rootLog.child({
    traceId,
    kind: req.body && req.body.kind,
    jobId: req.body && req.body.jobId,
    noteId: req.body && req.body.noteId,
    workspaceId: req.body && req.body.workspaceId,
    userId: req.body && req.body.uid,
  });

  // §4.6 spend circuit breaker (spend-gate.js): kickoffs only.
  const halted = await spendGate(req.body, {
    db, mirror, log, traceId, terminalHooks, noteTerminal, spendGuard,
  });
  if (halted) return res.status(halted.status).json(halted.body);

  const tasks = tasksClient.makeClient({ env, log, traceId, uid: req.body && req.body.uid });
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
    // Firestore, then dead-letter, refund and notify (the hooks below). The
    // kickoff mirrors nothing on the way out, so until here the app shows the
    // note processing; without this it would stay so until the stuck-note
    // sweep (db-job, 3.5 h). The ids come from the body (last-attempt.js).
    if (noteTerminal.isFinalAttempt(req.headers)) {
      await onLastAttempt({
        body: req.body, headers: req.headers, err, noteTerminal, terminalHooks, db, mirror, log, traceId,
      });
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  rootLog.info({ port }, 'transcoder_started');
});
