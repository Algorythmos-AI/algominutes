'use strict';

// The transcoder's Postgres writes and reads (the chunked pipeline, the fast
// path's result), in the repo layer where CLAUDE.md §1 says every note write
// lives. CommonJS, so the transcoder (and its tests) load it with plain require.
// Callers pass a client from their own pool; nothing here opens connections.
//
// These are the gates that make Cloud Task replay safe:
//   - claimSummarizerEnqueue / claimEmbedderEnqueue: exactly-once.
//   - markChunkDone: idempotent UPDATE.
//
// CLAUDE.md PII invariant: every transcript_lines write goes through
// redactTranscriptLines() before INSERT (insertTranscriptLines here; the fast
// path redacts at its call site before persistFastPathResult).

const _redaction = require('@algominutes/ai/redaction.cjs');

/**
 * Whether the task's note still exists in the task's workspace (deleted notes
 * are gone from Postgres; see notes-repo deleteNote). Checked before the
 * transcoder writes anything, so a note deleted after kickoff isn't touched.
 */
async function noteExists(client, { noteId, workspaceId }) {
  const { rowCount } = await client.query(
    'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [noteId, workspaceId],
  );
  return rowCount > 0;
}

/**
 * The note's status in the task's workspace, or null when it is gone or isn't
 * there (the kickoff's replay guard).
 */
async function noteStatus(client, { noteId, workspaceId }) {
  const { rows } = await client.query(
    'SELECT status FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [noteId, workspaceId],
  );
  return rows[0] ? rows[0].status : null;
}

// Scoped to the task's workspace (CLAUDE.md §1): a note id from another
// workspace, or a deleted note, matches nothing and throws NOTE_NOT_FOUND,
// which the handler treats as "note gone".
async function upsertNoteStatus(client, { noteId, workspaceId, status, durationSecProbed, chunksTotal, errorMessage }) {
  if (!workspaceId) throw new Error('upsertNoteStatus: workspaceId is required');
  const sets = ['status = $3', 'updated_at = NOW()'];
  const params = [noteId, workspaceId, status];
  let next = 4;
  if (durationSecProbed != null) { sets.push(`duration_sec_probed = $${next++}`); params.push(durationSecProbed); }
  if (chunksTotal != null) { sets.push(`chunks_total = $${next++}`); params.push(chunksTotal); }
  if (errorMessage !== undefined) { sets.push(`error_message = $${next++}`); params.push(errorMessage); }
  const sql = `UPDATE notes SET ${sets.join(', ')} WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id`;
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

/** A chunk that can't be transcribed (the terminal path fails its note next). */
async function markChunkError(client, chunkId) {
  await client.query(`UPDATE audio_chunks SET status = 'error' WHERE id = $1`, [chunkId]);
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
  // six-chunk recording, and claimSummarizerEnqueue then made it permanent: the
  // note reached 'ready' carrying a fluent, complete-looking summary of a third
  // of the recording. Nothing anywhere reported an error. For a meeting
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
 * meeting transcript is not.
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

/**
 * The note's chunk progress, for the progress mirror; null when the note is
 * gone or isn't in the task's workspace (CLAUDE.md §1).
 */
async function chunkProgress(client, { noteId, workspaceId }) {
  const { rows } = await client.query(
    `SELECT chunks_done AS "done", chunks_total AS "total" FROM notes
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [noteId, workspaceId],
  );
  return rows[0] || null;
}

/**
 * The note's author and workspace, for the dead-letter row and the author's
 * notification when a task carried no uid. Scoped to the task's workspace when
 * it has one (CLAUDE.md §1): a note id from another workspace matches nothing,
 * so that note's author is never told about this task. A task without one gets
 * the note's own workspace. Null when nothing matches.
 */
async function noteAuthor(client, { noteId, workspaceId }) {
  const { rows } = workspaceId
    ? await client.query(
      'SELECT author_uid AS "uid", workspace_id AS "workspaceId" FROM notes WHERE id = $1 AND workspace_id = $2',
      [noteId, workspaceId],
    )
    : await client.query(
      'SELECT author_uid AS "uid", workspace_id AS "workspaceId" FROM notes WHERE id = $1',
      [noteId],
    );
  return rows[0] || null;
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

/**
 * The fast path's whole result, in one transaction: 'ready', the (already
 * redacted) transcript lines, the summary, action items and key decisions.
 * `lines` are `{ startMs, text }`. Throws after a rollback; a failed rollback
 * is logged (never swallowed).
 */
async function persistFastPathResult(pool, { noteId, workspaceId, lines, summary, model }, log) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertNoteStatus(client, { noteId, workspaceId, status: 'ready' });
    await deleteTranscriptLinesForNote(client, noteId);
    for (const l of lines) {
      await client.query(
        `INSERT INTO transcript_lines (note_id, speaker_tag, start_ms, end_ms, text, confidence)
           VALUES ($1, NULL, $2, $2, $3, NULL)`,
        [noteId, l.startMs || 0, l.text],
      );
    }
    await client.query(
      `INSERT INTO summaries (note_id, gist, long_summary, topics, model)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (note_id) DO UPDATE
         SET gist = EXCLUDED.gist, long_summary = EXCLUDED.long_summary,
             topics = EXCLUDED.topics, model = EXCLUDED.model,
             generated_at = NOW()`,
      [noteId, summary.gist || '', null, JSON.stringify(summary.actionItems || []), model || null],
    );
    await client.query('DELETE FROM action_items WHERE note_id = $1', [noteId]);
    for (const item of summary.actionItems || []) {
      await client.query('INSERT INTO action_items (note_id, text) VALUES ($1, $2)', [noteId, item]);
    }
    await client.query('DELETE FROM key_decisions WHERE note_id = $1', [noteId]);
    for (const dec of summary.keyDecisions || []) {
      await client.query('INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)', [noteId, dec]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => log.error({ err: rollbackErr, noteId, workspaceId }, 'fast_path_rollback_failed'));
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  noteExists,
  noteStatus,
  fetchPriorChunkEndMs,
  upsertNoteStatus,
  insertAudioChunkRow,
  setChunkOperation,
  markChunkDone,
  markChunkError,
  claimSummarizerEnqueue,
  claimEmbedderEnqueue,
  fetchTailWords,
  insertTranscriptLines,
  deleteTranscriptLinesForNote,
  getChunkRow,
  chunkProgress,
  noteAuthor,
  persistFastPathResult,
};
