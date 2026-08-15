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
const sharedEmbeddings = loadShared('embeddings.cjs');
const noteTerminal = loadShared('note-terminal.cjs');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  // Cloud SQL pg_hba.conf rejects unencrypted connections from the VPC
  // connector range. Same fix as services/transcoder/src/db.js:35.
  // Without this the embedder fails every task with
  // "pg_hba.conf rejects connection ... no encryption" and the
  // alpha search/chat path has no embeddings to query (Bug 16).
  const ssl = { rejectUnauthorized: false };
  _pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl, max: 4, idleTimeoutMillis: 30000 }
      : {
          host: process.env.PGHOST,
          port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
          database: process.env.PGDATABASE || 'postgres',
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD,
          ssl,
          max: 4,
          idleTimeoutMillis: 30000,
        },
  );
  return _pool;
}

const app = express();
app.use(express.json({ limit: '64kb' }));
const rootLog = sharedLogger.logger.child({ svc: 'embedder' });

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const { noteId, workspaceId } = req.body || {};
  const traceId = sharedLogger.traceIdFrom(req.headers);
  const log = rootLog.child({ traceId, noteId });
  if (!noteId || !workspaceId) return res.status(400).json({ error: 'missing noteId/workspaceId' });

  try {
    const client = await pool().connect();
    let transcript;
    try {
      const { rows } = await client.query(
        `SELECT speaker_tag AS "speakerTag", start_ms AS "startMs", end_ms AS "endMs", text
           FROM transcript_lines WHERE note_id = $1 ORDER BY start_ms ASC`,
        [noteId],
      );
      transcript = rows;
    } finally { client.release(); }

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
    }
    return res.status(500).json({ error: 'task_failed' });
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'embedder_started'));
