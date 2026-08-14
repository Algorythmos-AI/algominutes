'use strict';

// Postgres pool + the chunked-pipeline helpers that have to be atomic.
// These are the gates that make Cloud Task replay safe:
//   - claimSummarizerEnqueue / claimEmbedderEnqueue: exactly-once.
//   - markChunkDone: idempotent UPDATE.
//
// CLAUDE.md §2 PII invariant: every transcript_lines write goes through
// redactTranscriptLines() before INSERT. The fast-path already redacts
// at its call site (services/transcoder/src/fast-path.js:42); the chunked
// path now redacts inside insertTranscriptLines() so no caller can bypass.

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}
const _redaction = loadShared('redaction.cjs');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 30000 }
      : {
          host: process.env.PGHOST,
          port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
          database: process.env.PGDATABASE || 'postgres',
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD,
          ssl: { rejectUnauthorized: false },
          max: 4,
          idleTimeoutMillis: 30000,
        },
  );
  return _pool;
}

async function upsertNoteStatus(client, { noteId, status, durationSecProbed, chunksTotal, errorMessage }) {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params = [noteId, status];
  let next = 3;
  if (durationSecProbed != null) { sets.push(`duration_sec_probed = $${next++}`); params.push(durationSecProbed); }
  if (chunksTotal != null) { sets.push(`chunks_total = $${next++}`); params.push(chunksTotal); }
  if (errorMessage !== undefined) { sets.push(`error_message = $${next++}`); params.push(errorMessage); }
  const sql = `UPDATE notes SET ${sets.join(', ')} WHERE id = $1 RETURNING id`;
  const { rows } = await client.query(sql, params);
  if (rows.length === 0) {
    const err = new Error(`note_missing_in_postgres:${noteId}`);
    err.code = 'NOTE_NOT_FOUND';
    throw err;
  }
}

async function insertAudioChunkRow(client, { noteId, idx, startSec, endSec, storagePath }) {
  const sql = `
    INSERT INTO audio_chunks (note_id, idx, start_sec, end_sec, storage_path, status)
    VALUES ($1, $2, $3, $4, $5, 'pending')
    ON CONFLICT (note_id, idx) DO UPDATE
      SET start_sec = EXCLUDED.start_sec,
          end_sec   = EXCLUDED.end_sec,
          storage_path = EXCLUDED.storage_path
    RETURNING id`;
  const { rows } = await client.query(sql, [noteId, idx, startSec, endSec, storagePath]);
  return rows[0].id;
}

async function setChunkOperation(client, { chunkId, operationName }) {
  await client.query('UPDATE audio_chunks SET stt_operation_id = $2 WHERE id = $1', [chunkId, operationName]);
}

async function markChunkDone(client, { chunkId, noteId }) {
  // Atomic + idempotent.
  await client.query(
    `UPDATE audio_chunks SET status = 'done' WHERE id = $1 AND status <> 'done'`,
    [chunkId],
  );
  await client.query(
    `UPDATE notes SET chunks_done = (
       SELECT COUNT(*) FROM audio_chunks WHERE note_id = $1 AND status = 'done'
     ), updated_at = NOW() WHERE id = $1`,
    [noteId],
  );
  // Gate on chunks_done = chunks_total, NOT on "no pending rows".
  //
  // The rows are inserted one at a time inside runChunkedPath's loop, so for
  // most of a long kickoff only a PREFIX of the plan exists in audio_chunks.
  // "No pending rows" is therefore true whenever every row inserted *so far*
  // has finished — which happens routinely if the kickoff task is re-dispatched
  // (Cloud Tasks' dispatch deadline is shorter than Cloud Run's timeout) and
  // the already-enqueued polls land in the gap.
  //
  // The old check let the summarizer run on the first two chunks of a
  // six-chunk consult, and claimSummarizerEnqueue then made it permanent: the
  // note reached 'ready' carrying a fluent, complete-looking summary of a third
  // of the recording. Nothing anywhere reported an error. For a clinical
  // transcript that is the worst possible failure — confidently wrong.
  //
  // chunks_total is written up front from plan.length (handler.js), so it is
  // the authoritative denominator from the first moment the note is chunked.
  const { rows } = await client.query(
    `SELECT n.chunks_total::int AS total,
            (SELECT COUNT(*) FROM audio_chunks c
              WHERE c.note_id = n.id AND c.status = 'done')::int AS done
       FROM notes n WHERE n.id = $1`,
    [noteId],
  );
  const row = rows[0];
  if (!row || row.total == null) return false;
  return row.done === row.total;
}

async function claimSummarizerEnqueue(client, noteId) {
  const { rows } = await client.query(
    `UPDATE notes SET summarizer_enqueued_at = NOW()
       WHERE id = $1 AND summarizer_enqueued_at IS NULL
       RETURNING id`,
    [noteId],
  );
  return rows.length > 0;
}

async function claimEmbedderEnqueue(client, noteId) {
  const { rows } = await client.query(
    `UPDATE notes SET embedder_enqueued_at = NOW()
       WHERE id = $1 AND embedder_enqueued_at IS NULL
       RETURNING id`,
    [noteId],
  );
  return rows.length > 0;
}

async function fetchTailWords(client, { noteId, fromMs }) {
  const { rows } = await client.query(
    `SELECT id, start_ms AS "startMs", end_ms AS "endMs", text, confidence, speaker_tag AS "speakerTag"
       FROM transcript_lines
       WHERE note_id = $1 AND start_ms >= $2
       ORDER BY start_ms ASC`,
    [noteId, fromMs],
  );
  return rows;
}

/**
 * End of the chunk immediately before `idx`, in absolute ms.
 *
 * The overlap dedup uses this rather than text similarity: what the prior
 * chunk covered is recorded in audio_chunks, so it is a fact rather than
 * something to infer from comparing strings. Returns null when there is no
 * prior row — errored, or purged by a retry — and the caller then keeps every
 * word, because duplicated speech is a nuisance and dropped speech in a
 * clinical transcript is not.
 */
async function fetchPriorChunkEndMs(client, { noteId, idx }) {
  const { rows } = await client.query(
    `SELECT end_sec FROM audio_chunks
      WHERE note_id = $1 AND idx = $2`,
    [noteId, idx - 1],
  );
  if (!rows[0] || rows[0].end_sec == null) return null;
  return Math.round(Number(rows[0].end_sec) * 1000);
}

async function insertTranscriptLines(client, { noteId, chunkId, lines, log }) {
  // CLAUDE.md §2 PII invariant: redact BEFORE storage so embedder/summarizer/
  // search downstream see only redacted text. Same shape contract as
  // fast-path's call to redactTranscriptLines.
  const { lines: redacted, counts } = _redaction.redactTranscriptLines(lines || []);
  if (log && counts && Object.keys(counts).length > 0) {
    log.info({ noteId, chunkId, redactionCounts: counts }, 'transcript_redacted_chunked');
  }
  for (let i = 0; i < redacted.length; i++) {
    const l = redacted[i];
    await client.query(
      `INSERT INTO transcript_lines (note_id, chunk_id, idx, speaker_tag, start_ms, end_ms, text, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (chunk_id, idx) WHERE chunk_id IS NOT NULL DO NOTHING`,
      [noteId, chunkId, i, l.speakerTag || null, l.startMs, l.endMs, l.text, l.confidence],
    );
  }
}

async function deleteTranscriptLinesForNote(client, noteId) {
  await client.query('DELETE FROM transcript_lines WHERE note_id = $1', [noteId]);
}

async function getChunkRow(client, chunkId) {
  const { rows } = await client.query(
    `SELECT id, note_id AS "noteId", idx, start_sec AS "startSec", end_sec AS "endSec",
            storage_path AS "storagePath", status, stt_operation_id AS "sttOperationId"
       FROM audio_chunks WHERE id = $1`,
    [chunkId],
  );
  return rows[0] || null;
}

module.exports = {
  fetchPriorChunkEndMs,
  pool,
  upsertNoteStatus,
  insertAudioChunkRow,
  setChunkOperation,
  markChunkDone,
  claimSummarizerEnqueue,
  claimEmbedderEnqueue,
  fetchTailWords,
  insertTranscriptLines,
  deleteTranscriptLinesForNote,
  getChunkRow,
};
