'use strict';

// Embeddings + chunking for the RAG pipeline.
// Used by the kickoff Function (fast Gemini path) and by the embedder
// Cloud Run service. Postgres is the storage target; if WRITE_POSTGRES
// is off the indexer becomes a no-op so prod deploys without Cloud SQL
// still succeed.
//
// CLAUDE.md §2 PII invariant: redact at the chunk boundary so BOTH the
// Vertex :predict call AND the embeddings.chunk_text Postgres write
// receive already-redacted text. Defence-in-depth: even if an upstream
// path forgot to redact transcript_lines (legacy corpus, future bypass),
// the embedder still sees redacted content.

const _redaction = require('./redaction.cjs');

const TARGET_CHARS = 2000;
const OVERLAP_CHARS = 200;
// Model id: models.cjs (lifecycle + Sydney availability).
const EMBED_MODEL = require('./models.cjs').EMBED_MODEL;
const EMBED_DIM = 768;

function timeStrToMs(t) {
  if (!t) return 0;
  const parts = String(t).split(':').map((n) => Number(n) || 0);
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

function chunkTranscript(lines, log) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  // Scrub the line texts in order FIRST, carrying a private key across lines
  // (redactLines). The "Speaker N: " prefix added below would otherwise break
  // a key body into pieces the chunk-level scrub can't join, and the overlap
  // carried into the next chunk would be cut from unredacted text.
  const { texts: scrubbed, counts: lineCounts } = _redaction.redactLines(lines.map((l) => (l && l.text) || ''));
  if (log && lineCounts && Object.keys(lineCounts).length > 0) {
    log.info({ redactionCounts: lineCounts }, 'embed_lines_redacted');
  }
  const out = [];
  let buffer = '';
  let bufferStart = null;
  let bufferEnd = 0;
  const flush = () => {
    if (!buffer.trim()) return;
    // Redact the whole chunk in one pass — patterns like emails or
    // multi-token Medicare numbers can span line boundaries when
    // concatenated across the chunk.
    const { text: redactedText, counts } = _redaction.redactPII(buffer.trim());
    if (log && counts && Object.keys(counts).length > 0) {
      log.info({ redactionCounts: counts, chunkChars: redactedText.length }, 'embed_chunk_redacted');
    }
    out.push({ text: redactedText, startMs: bufferStart || 0, endMs: bufferEnd });
    buffer = buffer.length > OVERLAP_CHARS ? buffer.slice(-OVERLAP_CHARS) : '';
    bufferStart = bufferEnd;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = scrubbed[i];
    const startMs = typeof line.startMs === 'number' ? line.startMs : timeStrToMs(line.time);
    const endMs = typeof line.endMs === 'number' ? line.endMs : startMs;
    const speakerLabel = line.speaker || (line.speakerTag != null ? `Speaker ${line.speakerTag}` : '');
    const formatted = speakerLabel ? `${speakerLabel}: ${text}` : text;
    if (bufferStart === null) bufferStart = startMs;
    if (buffer.length + formatted.length + 1 > TARGET_CHARS) flush();
    if (bufferStart === null) bufferStart = startMs;
    buffer += (buffer ? '\n' : '') + formatted;
    bufferEnd = endMs;
  }
  flush();
  return out;
}

function vectorToSqlText(values) {
  return '[' + values.join(',') + ']';
}

// Vertex AI text-embedding-004 (768-dim). The Generative Language API at
// generativelanguage.googleapis.com/v1beta returns 404 for this model
// from a public API key; the same model name on Vertex AI works with
// service-account ADC. The embedder Cloud Run service runs as
// `algominutes-jobs-sa` which has roles/aiplatform.user, so ADC just works
// here without an apiKey. See docs/runbooks/phase3-bug-log.md § Bug 11.
async function embedChunks({ chunks, log, project, location }) {
  const { GoogleAuth } = require('google-auth-library');
  const loc = location || process.env.AIPLATFORM_LOCATION || 'us-central1';

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  // Cloud Run doesn't auto-set GCLOUD_PROJECT; fall back to the metadata
  // server (which getProjectId() reads when no env hint is present).
  const proj = project
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || (await auth.getProjectId());
  if (!proj) throw new Error('embedChunks: project not resolvable');

  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp && tokenResp.token;
  if (!token) throw new Error('embedChunks: failed to mint ADC token');

  const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${EMBED_MODEL}:predict`;
  const vectors = [];
  for (const chunk of chunks) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ task_type: 'RETRIEVAL_DOCUMENT', content: chunk.text }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch((err) => {
        log.warn({ err }, 'vertex_embed_error_body_unreadable');
        return '';
      });
      log.error({ status: resp.status, body: errText.slice(0, 300) }, 'vertex_embed_http_error');
      throw new Error(`vertex_embed_failed: ${resp.status}`);
    }
    const data = await resp.json();
    const values = data && data.predictions && data.predictions[0] && data.predictions[0].embeddings && data.predictions[0].embeddings.values;
    if (!Array.isArray(values) || values.length !== EMBED_DIM) {
      log.error({ got: values && values.length }, 'vertex_embed_unexpected_shape');
      throw new Error('embedding_missing_values');
    }
    vectors.push(values);
  }
  return vectors;
}

async function indexEmbeddings({ pool, noteId, workspaceId, transcript, log, project, location }) {
  const chunks = chunkTranscript(transcript || [], log);
  if (chunks.length === 0) return { chunkCount: 0 };

  let vectors;
  try {
    vectors = await embedChunks({ chunks, log, project, location });
  } catch (err) {
    log.error({ err, noteId }, 'embedding_call_failed');
    return { chunkCount: 0 };
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
    log.error({ err, noteId }, 'embedding_write_failed');
    return { chunkCount: 0 };
  } finally {
    client.release();
  }
  log.info({ noteId, chunkCount: chunks.length }, 'embeddings_indexed');
  return { chunkCount: chunks.length };
}

module.exports = {
  TARGET_CHARS,
  OVERLAP_CHARS,
  EMBED_MODEL,
  EMBED_DIM,
  timeStrToMs,
  chunkTranscript,
  vectorToSqlText,
  embedChunks,
  indexEmbeddings,
};
