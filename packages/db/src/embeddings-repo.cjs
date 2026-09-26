'use strict';

// The embedder's Postgres reads and writes, in the repo layer (CLAUDE.md §1):
// the note's transcript for embedding, and its embeddings (replaced in one
// transaction). Chunking, the Vertex call and the constants stay in
// @algominutes/ai/embeddings.cjs. CommonJS, loaded with plain require.

const { chunkTranscript, embedChunks, vectorToSqlText, EMBED_MODEL } = require('@algominutes/ai/embeddings.cjs');

/**
 * The note's transcript lines to embed, or null when the note is gone or isn't
 * in the task's workspace. Scoped (CLAUDE.md §1): the embeddings are written
 * under the task's workspace_id, so reading lines by note id alone would let a
 * mismatched task index one workspace's words into another's search.
 */
async function loadTranscriptForEmbedding(pool, { noteId, workspaceId }) {
  const note = await pool.query(
    'SELECT 1 FROM notes WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [noteId, workspaceId],
  );
  if (!note.rowCount) return null;
  const { rows } = await pool.query(
    `SELECT speaker_tag AS "speakerTag", start_ms AS "startMs", end_ms AS "endMs", text
       FROM transcript_lines WHERE note_id = $1 ORDER BY start_ms ASC`,
    [noteId],
  );
  return rows;
}

// Throws when embedding or the write fails, so the embedder answers 5xx: Cloud
// Tasks retries, and the last attempt dead-letters (and alerts). It used to log
// and return chunkCount 0, which the embedder answered 200: the note was never
// retried and silently stayed out of Search and Chat. A deleted note surfaces
// as the write's foreign-key error (23503), which the embedder acknowledges.
// `embed` is a seam for tests.
async function indexEmbeddings({ pool, noteId, workspaceId, transcript, log, project, location, embed = embedChunks }) {
  const chunks = chunkTranscript(transcript || [], log);
  if (chunks.length === 0) return { chunkCount: 0 };

  const vectors = await embed({ chunks, log, project, location });
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    throw new Error(`embedding returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${chunks.length} chunks`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM embeddings WHERE note_id = $1', [noteId]);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const v = vectors[i];
      await client.query(
        `INSERT INTO embeddings (note_id, workspace_id, chunk_text, start_ms, end_ms, embedding, model)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [noteId, workspaceId, c.text, c.startMs, c.endMs, vectorToSqlText(v), EMBED_MODEL],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) =>
      log.error({ err: rollbackErr, noteId }, 'embedding_rollback_failed'),
    );
    throw err;
  } finally {
    client.release();
  }
  log.info({ noteId, chunkCount: chunks.length }, 'embeddings_indexed');
  return { chunkCount: chunks.length };
}

module.exports = { loadTranscriptForEmbedding, indexEmbeddings };
