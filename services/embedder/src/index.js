'use strict';

const express = require('express');
const { Pool } = require('pg');

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
  'embedder',
  {
    exact: { WRITE_POSTGRES: 'true' },
    oneOf: [
      { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
    ],
  },
  { logger: sharedLogger.logger },
);
const sharedEmbeddings = loadShared('embeddings.cjs');
const noteTerminal = loadShared('note-terminal.cjs');
const terminalHooks = require('./terminal-hooks');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  // Shared connection config (TLS policy + defaults): @algominutes/ai/pg-config.cjs.
  const { buildPgConfig, attachPoolErrorLogger } = loadShared('pg-config.cjs');
  _pool = attachPoolErrorLogger(new Pool(buildPgConfig({ max: 4 })), loadShared('logger.cjs').logger, { pool: 'embedder' });
  return _pool;
}

const app = express();
app.use(express.json({ limit: '64kb' }));
const rootLog = sharedLogger.logger.child({ svc: 'embedder' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const { noteId, workspaceId, uid } = req.body || {};
  // The enqueuer's traceId and the caller's uid, carried in the task body (CLAUDE.md §1).
  const traceId = sharedLogger.traceIdFromTask(req.body, req.headers);
  const log = rootLog.child({ traceId, noteId, workspaceId, userId: uid });
  if (!noteId || !workspaceId) return res.status(400).json({ error: 'missing noteId/workspaceId' });

  try {
    const transcript = await sharedEmbeddings.loadTranscriptForEmbedding(pool(), { noteId, workspaceId });
    if (transcript === null) {
      // Deleted (or not in this workspace): nothing to index, nothing to retry.
      log.warn({}, 'embedder_note_gone');
      return res.status(200).json({ ok: true, skipped: 'note_gone' });
    }

    // Vertex AI embeddings: ADC from the bound service account; no API key.
    const result = await sharedEmbeddings.indexEmbeddings({
      pool: pool(),
      noteId,
      workspaceId,
      transcript,
      log,
      project: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.AIPLATFORM_LOCATION || 'us-central1',
    });

    log.info({ chunkCount: result.chunkCount }, 'embedder_complete');
    return res.status(200).json({ ok: true, chunkCount: result.chunkCount });
  } catch (err) {
    // Deleted mid-run: the embeddings INSERT hits the notes foreign key.
    if (err && err.code === '23503') {
      log.warn({ constraint: err.constraint }, 'embedder_note_gone');
      return res.status(200).json({ ok: true, skipped: 'note_gone' });
    }
    log.error({ err }, 'embedder_task_failed');
    // Deliberately NOT marked as a failed note, unlike the transcoder and
    // summarizer. By the time embedding runs the transcript and summary exist
    // and the note is genuinely usable — flipping it to 'error' would hide a
    // good recording because of a search-index problem.
    //
    // But it is not nothing either: the note stays 'ready' and is silently
    // absent from Search and Chat, which is worse than a visible failure
    // because nobody goes looking. There is no column to record it in, so
    // this distinct event is what the alerting counts, and re-running the
    // db-job backfill is the fix.
    const { noteId, workspaceId } = req.body || {};
    if (noteTerminal.isFinalAttempt(req.headers)) {
      log.error(
        { noteId, workspaceId },
        'embedding_failed_permanently',
      );
      // A7.4: DLQ only — no refund, no notify. The note stays 'ready' and
      // readable; it is just absent from Search/Chat until the db-job backfill
      // re-runs, and this dead-letter row is what the admin view / alert counts.
      const attempts = Number((req.headers && req.headers['x-cloudtasks-taskretrycount']) || 0) + 1;
      await terminalHooks.onEmbedTerminalFailure({
        noteId,
        workspaceId,
        err,
        attempts,
        traceId,
        payload: { kind: 'embed', noteId, workspaceId },
        log,
      });
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'embedder_started'));
