'use strict';

/**
 * /v1/search and /v1/chat handlers.
 *
 * Mirrors the logic in @algominutes/db search-repo but in CJS so it can be
 * required from the API router without a TypeScript build step.
 *
 * Hybrid retrieval: vector cosine over `embeddings.embedding` +
 * pg_trgm similarity over `transcript_lines.text`, fused with
 * reciprocal rank fusion (k=60).
 *
 * Both endpoints require Postgres (WRITE_POSTGRES=true) and a Gemini
 * API key. They short-circuit cleanly when neither is available.
 *
 * Consolidated into services/api (BUILD-PLAN §3.1) from
 * functions/search-and-chat.cjs. The ONLY change from the source is the
 * shared-lib import path: redaction comes from @algominutes/ai, pg-query from
 * @algominutes/db. Behaviour is otherwise identical.
 */

const { GoogleAuth } = require('google-auth-library');

const { redactPII } = require('@algominutes/ai/redaction.cjs');
const models = require('@algominutes/ai/models.cjs');
// pool / withQueryTimeout / postgresEnabled live in @algominutes/db pg-query.cjs
// so note-read and the other read-path handlers share one pool and one timeout
// discipline. Moved verbatim; behaviour unchanged.
const { withQueryTimeout, postgresEnabled } = require('@algominutes/ai/pg-query.cjs');

// Vertex AI client. Single auth instance (caches tokens across calls).
// search-and-chat used to call generativelanguage.googleapis.com (the
// public API) via @google/generative-ai. That worked under the
// Firebase Function's egress but the rest of Phase 3 already moved
// off it (bug 11 + bug 13). Mirror the pattern here so the entire
// codebase uses Vertex AI from the bound service account.
let _auth = null;
function getAuth() {
  if (_auth) return _auth;
  _auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return _auth;
}

let _projectId = null;
async function getProjectId() {
  if (_projectId) return _projectId;
  _projectId = process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || (await getAuth().getProjectId());
  if (!_projectId) throw new Error('search-and-chat: project not resolvable');
  return _projectId;
}

async function vertexAuthHeader() {
  const client = await getAuth().getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp || !tokenResp.token) throw new Error('search-and-chat: failed to mint ADC token');
  return `Bearer ${tokenResp.token}`;
}

async function responseTextHead(resp) {
  try {
    return (await resp.text()).slice(0, 200);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return `response_body_unreadable: ${message}`;
  }
}

function vectorToSql(values) {
  // pgvector text format: '[a,b,c]'
  return '[' + values.join(',') + ']';
}

const RRF_K = 60;
const PER_LIST_LIMIT = 25;
// Model ids: packages/ai/src/models.cjs (lifecycle + Sydney availability).
const EMBED_MODEL = models.EMBED_MODEL;
const CHAT_MODEL = models.CHAT_MODEL;

// Vertex AI embedding endpoint can hang on cold-start of the publisher
// model. Without a client-side timeout the unbounded fetch blocks past
// the searchMeetings 30s function timeout and Cloud Functions returns
// 504 to the client with no log line — because the function is killed
// before the catch block runs. 8s is generous for a hot path (typical
// p99 ~1.5s) and gives Postgres + RRF + response render the rest of
// the function budget.
const EMBED_QUERY_TIMEOUT_MS = 8000;

// Embed a single search query via Vertex AI text-embedding-004. The
// `apiKey` arg is retained for call-site compatibility but ignored;
// auth comes from ADC. `log` is a pino-style logger forwarded from
// the request handler so timeouts surface in Cloud Logging.
async function embedQuery(_apiKey, text, log) {
  const project = await getProjectId();
  const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${EMBED_MODEL}:predict`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBED_QUERY_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: await vertexAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await responseTextHead(resp);
      throw new Error(`vertex_embed_failed: ${resp.status} ${errText}`);
    }
    const data = await resp.json();
    const values = data && data.predictions && data.predictions[0] && data.predictions[0].embeddings && data.predictions[0].embeddings.values;
    if (!Array.isArray(values)) throw new Error('embedding_missing_values');
    if (log && typeof log.info === 'function') {
      log.info({ ms: Date.now() - startedAt, queryLen: text.length }, 'embed_query_ok');
    }
    return values;
  } catch (err) {
    const ms = Date.now() - startedAt;
    if (err && err.name === 'AbortError') {
      if (log && typeof log.error === 'function') {
        log.error({ ms, timeoutMs: EMBED_QUERY_TIMEOUT_MS, queryHead: text.slice(0, 60) }, 'embed_query_timeout');
      }
      const wrapped = new Error('embed_query_timeout');
      wrapped.cause = err;
      wrapped.code = 'EMBED_TIMEOUT';
      throw wrapped;
    }
    if (log && typeof log.error === 'function') {
      log.error({ err, ms, queryHead: text.slice(0, 60) }, 'embed_query_failed');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function memberWorkspaces(uid, log) {
  const r = await withQueryTimeout({
    timeoutMs: 3000,
    text: `SELECT workspace_id FROM workspace_members WHERE uid = $1`,
    values: [uid],
    log,
    op: 'membership',
  });
  return r.rows.map((row) => row.workspace_id);
}

/// `noteId` narrows retrieval to a single note. It is an *additional*
/// predicate — the workspace filter is never replaced, so scoping cannot
/// widen access. A note the caller cannot reach resolves to zero member
/// workspaces here and the pre-check returns null, which the callers turn
/// into a 404 rather than an empty result set.
async function hybridSearch({ uid, query, k, apiKey, log, noteId }) {
  const workspaces = await memberWorkspaces(uid, log);
  if (workspaces.length === 0) return [];

  // Confirm the note is reachable before spending an embedding call on it.
  if (noteId) {
    const owned = await withQueryTimeout({
      timeoutMs: 3000,
      text: `SELECT id FROM notes
              WHERE id = $1 AND workspace_id = ANY($2) AND deleted_at IS NULL`,
      values: [noteId, workspaces],
      log,
      op: 'note_scope',
    });
    if (owned.rows.length === 0) return null;
  }

  let vectorRows = [];
  try {
    const vec = await embedQuery(apiKey, query, log);
    const r = await withQueryTimeout({
      timeoutMs: 12000,
      text: `SELECT e.note_id, n.title, e.chunk_text, e.start_ms, e.end_ms,
                    e.embedding <=> $1::vector AS distance
               FROM embeddings e
               JOIN notes n ON n.id = e.note_id
              WHERE e.workspace_id = ANY($2)
                AND n.deleted_at IS NULL
                ${noteId ? 'AND e.note_id = $4' : ''}
              ORDER BY e.embedding <=> $1::vector
              LIMIT $3`,
      values: noteId
        ? [vectorToSql(vec), workspaces, PER_LIST_LIMIT, noteId]
        : [vectorToSql(vec), workspaces, PER_LIST_LIMIT],
      log,
      op: 'vector',
    });
    vectorRows = r.rows;
  } catch (err) {
    if (log && typeof log.warn === 'function') {
      log.warn({ err, userId: uid }, 'search_vector_fallback');
    }
  }

  // Push the workspace filter into a subquery so the gin_trgm_ops index
  // on transcript_lines.text can run against a pre-filtered note set
  // instead of doing a similarity scan and filtering after the join.
  const kwRes = await withQueryTimeout({
    timeoutMs: 12000,
    text: `SELECT t.note_id, n.title, t.text AS chunk_text, t.start_ms, t.end_ms,
                  similarity(t.text, $1) AS sim
             FROM transcript_lines t
             JOIN notes n ON n.id = t.note_id
            WHERE t.note_id IN (
                    SELECT id FROM notes
                     WHERE workspace_id = ANY($2)
                       AND deleted_at IS NULL
                  )
              AND t.text % $1
              ${noteId ? 'AND t.note_id = $4' : ''}
            ORDER BY similarity(t.text, $1) DESC
            LIMIT $3`,
    values: noteId
      ? [query, workspaces, PER_LIST_LIMIT, noteId]
      : [query, workspaces, PER_LIST_LIMIT],
    log,
    op: 'trgm',
  });

  const fused = new Map();
  const fuseAdd = (key, rank, source, payload) => {
    const inc = 1 / (RRF_K + rank);
    const existing = fused.get(key);
    if (existing) {
      existing.score += inc;
      existing.source = 'fused';
    } else {
      fused.set(key, Object.assign({}, payload, { score: inc, source }));
    }
  };
  vectorRows.forEach((r, i) => {
    const key = `${r.note_id}:${r.start_ms}`;
    fuseAdd(key, i, 'vector', {
      noteId: r.note_id,
      noteTitle: r.title,
      chunkText: r.chunk_text,
      startMs: r.start_ms,
      endMs: r.end_ms,
    });
  });
  kwRes.rows.forEach((r, i) => {
    const key = `${r.note_id}:${r.start_ms}`;
    fuseAdd(key, i, 'keyword', {
      noteId: r.note_id,
      noteTitle: r.title,
      chunkText: r.chunk_text,
      startMs: r.start_ms,
      endMs: r.end_ms,
    });
  });

  // Redact chunk text at the read boundary — defense-in-depth so no raw PII
  // reaches the client (/api/search hits and the SSE `citations` event) or the
  // Gemini prompt, even if a pre-redaction ingest row slipped through. Order
  // and chunk count are preserved (see buildChatPrompt's contract).
  return redactHits(
    Array.from(fused.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(k || 10, 1), 50)),
  );
}

// Redacts chunkText on each hit, preserving array order and length so citation
// indices [1..N] stay positional.
function redactHits(hits) {
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => Object.assign({}, h, { chunkText: redactPII((h && h.chunkText) || '').text }));
}

async function handleSearch({ uid, body, apiKey, log }) {
  if (!postgresEnabled()) {
    return { status: 503, body: { error: 'Search is unavailable until Postgres is provisioned.' } };
  }
  const rawQuery = String(body && body.query || '').trim();
  if (!rawQuery) return { status: 400, body: { error: 'query is required' } };
  // CLAUDE.md §2: redact user input BEFORE it reaches the embedder (and
  // before logging). Prevents a user accidentally pasting an SSN or
  // Medicare number into the search box from poisoning the vector index
  // / Cloud Logging / Vertex audit trail.
  const { text: query, counts: queryCounts } = redactPII(rawQuery);
  if (Object.keys(queryCounts).length) {
    log.info({ uid, queryRedactionCounts: queryCounts }, 'search_query_redacted');
  }
  const k = Number(body && body.k) || 10;
  const noteId = body && body.noteId ? String(body.noteId) : undefined;
  try {
    const hits = await hybridSearch({ uid, query, k, apiKey, log, noteId });
    // null means the note is not reachable by this caller. 404 for both
    // "no such note" and "not yours", matching /api/note — a 403 would
    // confirm the note exists to someone who cannot read it.
    if (hits === null) {
      log.info({ uid, noteId }, 'search_note_not_found');
      return { status: 404, body: { error: 'Note not found' } };
    }
    // Log redacted query only — never raw user input.
    log.info({ uid, userId: uid, query, hitCount: hits.length }, 'search_ok');
    return { status: 200, body: { hits } };
  } catch (err) {
    log.error({ err }, 'search_failed');
    return { status: 500, body: { error: 'Search failed' } };
  }
}

// CLAUDE.md §2 PII invariant: scrub retrieved transcript chunks before
// they reach Gemini. Citation indices [1]..[N] map positionally to
// hits[0..N-1]; redaction must NOT change array order or chunk count.
// Returns `{ prompt, redactionCounts }` so the caller can log aggregate
// counts without re-running the regex.
// `scoped` is passed explicitly rather than inferred from the hits, because
// a single-note conversation whose retrieval returned nothing would otherwise
// silently fall back to the all-meetings phrasing and invite the model to
// reason across notes it was never given.
function buildChatPrompt(question, hits, scoped = false) {
  const totalCounts = {};
  const blocks = hits
    .map((h, i) => {
      const { text: redactedChunk, counts } = redactPII(h.chunkText || '');
      for (const [k, v] of Object.entries(counts)) {
        totalCounts[k] = (totalCounts[k] || 0) + v;
      }
      // Scoped conversations are already about one note, so the note id is a
      // constant on every block — noise that costs tokens and tells the model
      // nothing. Citation indices stay positional either way.
      return scoped
        ? `[${i + 1}] (t=${h.startMs}ms) ${redactedChunk}`
        : `[${i + 1}] (note=${h.noteId} t=${h.startMs}ms) ${redactedChunk}`;
    })
    .join('\n\n');
  const lead = scoped
    ? "You are a meeting intelligence assistant. The user is asking about ONE specific meeting. Answer using ONLY the numbered context blocks below, which are all excerpts from that meeting."
    : "You are a meeting intelligence assistant. Answer the user's question using ONLY the numbered context blocks below.";
  const prompt = `${lead} Cite sources inline using bracketed numbers like [1] [3]. If the context doesn't answer the question, say so directly — do not invent details.

Context:
${blocks || '(no relevant excerpts found)'}

Question: ${question}

Answer (with inline [n] citations):`;
  return { prompt, redactionCounts: totalCounts };
}

// Parse one SSE line from the Vertex answer stream into a structured result.
// Pure so the framing logic is unit-testable (tests/sse-parser.test.ts).
// Vertex delimits events with CRLF (`\r\n\r\n`); we work line-by-line and
// strip a trailing CR. The previous `buf.indexOf('\n\n')` framing never
// matched CRLF, so every answer chunk was silently dropped while the
// citations frame still rendered — the "sources appear but no message" bug.
function parseSseDataLine(rawLine) {
  const line = String(rawLine).replace(/\r$/, '').trim();
  if (!line || !line.startsWith('data:')) return { type: 'skip' };
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return { type: 'skip' };
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (parseErr) {
    return { type: 'parse_error', parseErr, payloadHead: payload.slice(0, 80) };
  }
  const parts = obj && obj.candidates && obj.candidates[0]
    && obj.candidates[0].content && obj.candidates[0].content.parts;
  const text = Array.isArray(parts)
    ? parts.map((p) => p && p.text).filter(Boolean).join('')
    : '';
  return text ? { type: 'text', text } : { type: 'skip' };
}

// Incremental line splitter for a decoded byte stream: buffers partial lines
// across chunk boundaries, emits each complete line to onLine, and flush()
// drains a trailing line that arrived without a terminating newline.
function createSseLineFeeder(onLine) {
  let buf = '';
  return {
    feed(str) {
      buf += str;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

/**
 * Chat handler streams an SSE response: each chunk arrives as
 * `data: {"text":"…"}\n\n` and a terminal `event: done` frame closes
 * the stream. The handler is invoked with (…, res) so it can write the
 * stream directly through the Express response.
 */
async function handleChatStream({ uid, body, apiKey, log, res }) {
  if (!postgresEnabled()) {
    res.status(503).json({ error: 'Chat is unavailable until Postgres is provisioned.' });
    return;
  }
  const rawQuestion = String(body && body.query || '').trim();
  if (!rawQuestion) {
    res.status(400).json({ error: 'query is required' });
    return;
  }
  const noteId = body && body.noteId ? String(body.noteId) : undefined;
  // CLAUDE.md §2: redact user-supplied question before embedder, before
  // Gemini prompt construction, before logs. The chat retrieval path
  // already redacts retrieved chunks (buildChatPrompt below); PR-A4
  // closes the symmetrical gap on the user's input.
  const { text: question, counts: questionCounts } = redactPII(rawQuestion);
  if (Object.keys(questionCounts).length) {
    log.info({ uid, questionRedactionCounts: questionCounts }, 'chat_question_redacted');
  }
  let hits = [];
  try {
    hits = await hybridSearch({ uid, query: question, k: 15, apiKey, log, noteId });
  } catch (err) {
    // Retrieval failure is deliberately non-fatal — the model answers with
    // no context rather than the request dying. That is NOT true of an
    // unreachable note, which is handled below before the stream opens.
    log.error({ err }, 'chat_retrieval_failed');
  }
  // A scoped request for a note the caller cannot reach is a hard 404, not a
  // context-free answer. Checked before any SSE header is written, because
  // once the stream opens the status is already committed.
  if (hits === null) {
    log.info({ uid, noteId }, 'chat_note_not_found');
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  const { prompt, redactionCounts } = buildChatPrompt(question, hits, Boolean(noteId));
  if (Object.keys(redactionCounts).length) {
    log.info({ uid, hitCount: hits.length, redactionCounts }, 'chat_chunks_redacted');
  }

  // PII-bearing debug log — emits the *full outbound prompt text* including
  // the question and retrieved chunks (post-redaction). Gated on
  // LOG_CHAT_PROMPT_DEBUG=true env var so it stays OFF in production.
  // Used only by the staging-fire verification step in PR-A's body —
  // confirms <<REDACTED:*>> tags appear in the actual payload sent to
  // Vertex, not inferred from the prompt-construction code.
  //
  // The prompt itself is no longer logged. It is post-redaction, but it still
  // contains the retrieved meeting chunks verbatim — an entire meeting's
  // worth of a real person's words landing in Cloud Logging, retained under
  // that bucket's policy and readable by anyone with log access. That is a
  // wider audience than the note itself has.
  //
  // What the verification actually needed was proof that <<REDACTED:*>> tags
  // reach the payload, and a count of them establishes that without shipping
  // the text. If a future investigation genuinely needs the prompt body, take
  // it from a staging project with synthetic data, not from production.
  if (process.env.LOG_CHAT_PROMPT_DEBUG === 'true') {
    const redactionTags = (prompt.match(/<<REDACTED:[A-Z_]+>>/g) || []).length;
    log.info(
      { uid, hitCount: hits.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), redactionTags },
      'chat_prompt_outbound_debug',
    );
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  // Send citations up front so the UI can render them while the answer streams in.
  res.write(`event: citations\ndata: ${JSON.stringify({ hits })}\n\n`);

  try {
    // Vertex AI streaming generate. The :streamGenerateContent endpoint
    // with ?alt=sse returns SSE chunks of `data: { candidates: [...] }`,
    // which we parse and forward as our own `data: { text }` events.
    const project = await getProjectId();
    const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${CHAT_MODEL}:streamGenerateContent?alt=sse`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { Authorization: await vertexAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const errText = upstream.body ? await responseTextHead(upstream) : '';
      throw new Error(`vertex_stream_failed: ${upstream.status} ${errText.slice(0, 200)}`);
    }

    const decoder = new TextDecoder();
    let emittedText = false;

    const feeder = createSseLineFeeder((rawLine) => {
      const parsed = parseSseDataLine(rawLine);
      if (parsed.type === 'parse_error') {
        log.warn({ uid, parseErr: parsed.parseErr, payloadHead: parsed.payloadHead }, 'chat_stream_parse_failed');
        return;
      }
      if (parsed.type === 'text') {
        res.write(`data: ${JSON.stringify({ text: parsed.text })}\n\n`);
        emittedText = true;
      }
    });

    for await (const chunk of upstream.body) {
      feeder.feed(decoder.decode(chunk, { stream: true }));
    }
    feeder.flush(); // trailing line with no terminating newline

    // Diagnostic: retrieval succeeded (citations sent) but the model stream
    // yielded no text. If this fires after the CRLF fix, the cause is upstream
    // (model/response shape), not our framing.
    if (!emittedText) {
      log.warn({ uid, hitCount: hits.length }, 'chat_stream_no_text_emitted');
    }
    res.write(`event: done\ndata: {}\n\n`);
  } catch (err) {
    log.error({ err }, 'chat_stream_failed');
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'stream_failed' })}\n\n`);
  } finally {
    res.end();
  }
}

module.exports = { handleSearch, handleChatStream, hybridSearch, buildChatPrompt, redactHits, parseSseDataLine, createSseLineFeeder };
