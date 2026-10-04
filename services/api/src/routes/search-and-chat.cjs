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
const { vertexRefusal } = require('@algominutes/ai/vertex-refusal.cjs');
const { isValidId } = require('@algominutes/ai/intelligence.cjs');
const models = require('@algominutes/ai/models.cjs');
// pool / withQueryTimeout / postgresEnabled live in @algominutes/db pg-query.cjs
// so note-read and the other read-path handlers share one pool and one timeout
// discipline. Moved verbatim; behaviour unchanged.
const { withQueryTimeout, postgresEnabled, pool: readPool } = require('@algominutes/ai/pg-query.cjs');
const spendGuard = require('@algominutes/ai/spend-guard.cjs');
const { recordPaidWork } = require('@algominutes/db/pipeline-repo.cjs');
const { CHAT_EVENT } = require('@algominutes/db/spend-repo.cjs');

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
const { thinkingConfigFor } = models;

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
// the request handler so timeouts surface in Cloud Logging. Its lines carry
// the query's length, never its text: what users type into search is theirs,
// scrubbed or not, as chat keeps meeting content out of logs. `fetchImpl` and
// `authHeader` are for tests.
async function embedQuery(_apiKey, text, log, { fetchImpl = fetch, authHeader = vertexAuthHeader } = {}) {
  const project = await getProjectId();
  const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${EMBED_MODEL}:predict`;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EMBED_QUERY_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // The status and its enum only: a 400 can quote the query back (Q29).
      throw vertexRefusal('vertex_embed_failed:', resp.status, await responseTextHead(resp));
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
        log.error({ ms, timeoutMs: EMBED_QUERY_TIMEOUT_MS, queryLen: text.length }, 'embed_query_timeout');
      }
      const wrapped = new Error('embed_query_timeout');
      wrapped.cause = err;
      wrapped.code = 'EMBED_TIMEOUT';
      throw wrapped;
    }
    if (log && typeof log.error === 'function') {
      log.error({ err, ms, queryLen: text.length }, 'embed_query_failed');
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
// `embed` is the query-embedding call (a seam for tests; production uses the
// Vertex one above).
async function hybridSearch({ uid, query, k, apiKey, log, noteId, embed = embedQuery }) {
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
    const vec = await embed(apiKey, query, log);
    // Only rows embedded by the model that embedded the query: vectors from
    // different models don't compare, and the text-embedding-004 →
    // gemini-embedding-001 migration (before 2027-04-01) re-embeds in place
    // while both kinds of row exist.
    const r = await withQueryTimeout({
      timeoutMs: 12000,
      text: `SELECT e.note_id, n.title, e.chunk_text, e.start_ms, e.end_ms,
                    e.embedding <=> $1::vector AS distance
               FROM embeddings e
               JOIN notes n ON n.id = e.note_id
              WHERE e.workspace_id = ANY($2)
                AND e.model = $4
                AND n.deleted_at IS NULL
                -- A failed run's note: its rows may be from an earlier run (rev 11 N7).
                AND n.status <> 'error'
                ${noteId ? 'AND e.note_id = $5' : ''}
              ORDER BY e.embedding <=> $1::vector
              LIMIT $3`,
      values: noteId
        ? [vectorToSql(vec), workspaces, PER_LIST_LIMIT, EMBED_MODEL, noteId]
        : [vectorToSql(vec), workspaces, PER_LIST_LIMIT, EMBED_MODEL],
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
                       AND status <> 'error'
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

// A search or chat narrowed to one note logs with its noteId (CLAUDE.md §1),
// bound once so every line below, the Postgres timing lines included, has it.
// Only a well-formed id: it comes from the request body, and an arbitrary
// string mustn't ride along on every line (as logger.cjs does for traceId).
function noteLog(log, noteId) {
  return noteId && isValidId(noteId) && log && typeof log.child === 'function' ? log.child({ noteId }) : log;
}

// RELEASE.md rev 11, L4 (H9a): a question is at most this long. Nothing bounded it but the 1 MB body limit, so one
// request could send a 250k-token prompt to the embedder and to Gemini.
const MAX_QUESTION_CHARS = 2000;
// A chat answer is a few paragraphs: bounded, with the model's thinking capped inside it.
// The cap's field is the chat model's own (models.cjs thinkingConfigFor): gemini-3.x takes thinkingLevel, and some of
// its Sydney backends refuse thinkingBudget, which failed chat answers at random (2026-10-01).
const CHAT_MAX_OUTPUT_TOKENS = 2048;

/** The Vertex request for a chat answer. */
function chatRequestBody(prompt, model = CHAT_MODEL) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS, thinkingConfig: thinkingConfigFor(model, { budget: 1024 }) },
  };
}

async function handleSearch({ uid, body, apiKey, log: requestLog, embed }) {
  if (!postgresEnabled()) {
    return { status: 503, body: { error: 'Search is unavailable until Postgres is provisioned.' } };
  }
  const noteId = body && body.noteId ? String(body.noteId) : undefined;
  const log = noteLog(requestLog, noteId);
  const rawQuery = String(body && body.query || '').trim();
  if (!rawQuery) return { status: 400, body: { error: 'query is required' } };
  if (rawQuery.length > MAX_QUESTION_CHARS) {
    log.warn({ uid, queryLen: rawQuery.length }, 'search_query_too_long');
    return { status: 400, body: { error: 'Keep your search under 2,000 characters.' } };
  }
  // CLAUDE.md §2: redact user input BEFORE it reaches the embedder (and
  // before logging). Prevents a user accidentally pasting an SSN or
  // Medicare number into the search box from poisoning the vector index
  // / Cloud Logging / Vertex audit trail.
  const { text: query, counts: queryCounts } = redactPII(rawQuery);
  if (Object.keys(queryCounts).length) {
    log.info({ uid, queryRedactionCounts: queryCounts }, 'search_query_redacted');
  }
  const k = Number(body && body.k) || 10;
  try {
    const hits = await hybridSearch({ uid, query, k, apiKey, log, noteId, ...(embed ? { embed } : {}) });
    // null means the note is not reachable by this caller. 404 for both
    // "no such note" and "not yours", matching /api/note — a 403 would
    // confirm the note exists to someone who cannot read it.
    if (hits === null) {
      log.info({ uid }, 'search_note_not_found'); // noteId is bound when well-formed
      return { status: 404, body: { error: 'Note not found' } };
    }
    // The query's length, not its text (see embedQuery).
    log.info({ uid, userId: uid, queryLen: query.length, hitCount: hits.length }, 'search_ok');
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
// How much of a note's own summary the chat prompt carries (RELEASE.md rev 11, LM10): a bound, as the question's is.
const OVERVIEW_MAX_CHARS = 6000;
const OVERVIEW_MAX_CHAPTERS = 40;

/**
 * The note's summary and chapters, for a chat about that one note (LM10). Retrieval finds the 15 excerpts
 * nearest the question, which answers "what did Priya say about pricing" and not "what was this meeting
 * about" or "what came after the budget part" on a 3-hour note. Membership-filtered, as every query that
 * returns user data is. Null when there is no summary (or no access): the prompt is then as before.
 */
async function noteOverview({ uid, noteId, log }) {
  const r = await withQueryTimeout({
    timeoutMs: 3000,
    text: `SELECT s.gist, s.long_summary, s.chapters
             FROM summaries s
             JOIN notes n ON n.id = s.note_id
             JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.uid = $2
            WHERE s.note_id = $1 AND n.deleted_at IS NULL AND n.status <> 'error'`,
    values: [noteId, uid],
    log,
    op: 'note_overview',
  });
  const row = r.rows[0];
  if (!row) return null;
  const chapters = (Array.isArray(row.chapters) ? row.chapters : [])
    .filter((c) => c && typeof c.title === 'string' && Number.isFinite(Number(c.startMs)))
    .slice(0, OVERVIEW_MAX_CHAPTERS)
    .map((c) => ({ startMs: Number(c.startMs), title: c.title, summary: typeof c.summary === 'string' ? c.summary : '' }));
  const summary = [row.gist, row.long_summary].filter((t) => typeof t === 'string' && t.trim()).join('\n\n');
  if (!summary && chapters.length === 0) return null;
  return { summary, chapters };
}

/** The overview as prompt text, scrubbed like the excerpts are, and bounded. */
function overviewBlock(overview, totalCounts) {
  if (!overview) return '';
  const scrub = (text) => {
    const { text: out, counts } = redactPII(text || '');
    for (const [k, v] of Object.entries(counts)) totalCounts[k] = (totalCounts[k] || 0) + v;
    return out;
  };
  const lines = [];
  if (overview.summary) lines.push(`Summary: ${scrub(overview.summary)}`);
  if (overview.chapters.length) {
    lines.push('Chapters, in order:');
    for (const c of overview.chapters) lines.push(`- (t=${c.startMs}ms) ${scrub(c.title)}${c.summary ? `: ${scrub(c.summary)}` : ''}`);
  }
  return lines.join('\n').slice(0, OVERVIEW_MAX_CHARS);
}

function buildChatPrompt(question, hits, scoped = false, overview = null) {
  const totalCounts = {};
  const about = scoped ? overviewBlock(overview, totalCounts) : '';
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
  // The overview answers what the meeting was about and how it went; only the numbered excerpts are cited.
  const overviewPart = about
    ? `\nOverview of the whole meeting (for orientation: do not cite it with a number, and prefer the excerpts for details):\n${about}\n`
    : '';
  const prompt = `${lead}${about ? ' An overview of the whole meeting comes first.' : ''} Cite sources inline using bracketed numbers like [1] [3]. If the context doesn't answer the question, say so directly — do not invent details.
${overviewPart}
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
    // Neither the payload nor Node's message: both quote the model's answer,
    // and meeting content stays out of logs even scrubbed.
    return { type: 'parse_error', errorName: parseErr.name, payloadChars: payload.length };
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
// What a capped day says in place of an answer (the kickoff's own cap message is about processing).
const CHAT_CAP_MESSAGE = "We've reached today's limit for answers. Please try again tomorrow.";

async function handleChatStream({ uid, body, apiKey, log: requestLog, res, deps = {} }) {
  const assertUnderDailyCap = deps.assertUnderDailyCap || spendGuard.assertUnderDailyCap;
  const recordChat = deps.recordChat || ((entry) => recordPaidWork(readPool(), entry));
  const fetchImpl = deps.fetchImpl || fetch;
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
  const log = noteLog(requestLog, noteId);
  if (rawQuestion.length > MAX_QUESTION_CHARS) {
    log.warn({ uid, queryLen: rawQuestion.length }, 'chat_question_too_long');
    res.status(400).json({ error: 'Keep your question under 2,000 characters.' });
    return;
  }
  // CLAUDE.md §2: redact user-supplied question before embedder, before
  // Gemini prompt construction, before logs. The chat retrieval path
  // already redacts retrieved chunks (buildChatPrompt below); PR-A4
  // closes the symmetrical gap on the user's input.
  const { text: question, counts: questionCounts } = redactPII(rawQuestion);
  if (Object.keys(questionCounts).length) {
    log.info({ uid, questionRedactionCounts: questionCounts }, 'chat_question_redacted');
  }
  // The daily spend cap stops chat as it stops the pipeline (RELEASE.md rev 11, H9), before the embedding and the
  // model are paid for. It fails open on a broken meter, as it does there.
  try {
    await assertUnderDailyCap({ log });
  } catch (err) {
    if (!err || err.code !== 'SPEND_CAP_EXCEEDED') throw err;
    log.warn({ uid, spent: err.spent, cap: err.cap }, 'chat_spend_cap_refused');
    res.status(503).json({ error: CHAT_CAP_MESSAGE });
    return;
  }
  let hits = [];
  try {
    hits = await hybridSearch({ uid, query: question, k: 15, apiKey, log, noteId, embed: deps.embed });
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
    log.info({ uid }, 'chat_note_not_found'); // noteId is bound when well-formed
    res.status(404).json({ error: 'Note not found' });
    return;
  }
  // A chat about one note also sees that note's summary and chapters (LM10). Best-effort, as retrieval is: an
  // overview that can't be read leaves the prompt as it was.
  let overview = null;
  if (noteId) {
    try {
      overview = await (deps.noteOverview || noteOverview)({ uid, noteId, log });
    } catch (err) {
      log.error({ err }, 'chat_overview_failed');
    }
  }
  const { prompt, redactionCounts } = buildChatPrompt(question, hits, Boolean(noteId), overview);
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
    const project = deps.project || await getProjectId();
    const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${CHAT_MODEL}:streamGenerateContent?alt=sse`;
    // Counted as it's asked, as the pipeline's paid work is (best-effort: a failed write is logged, never fatal).
    // Only a well-formed note id rides on the row and its failure log, as on every log line here (noteLog).
    await recordChat({ uid, noteId: noteId && isValidId(noteId) ? noteId : undefined, event: CHAT_EVENT, model: CHAT_MODEL, audioSeconds: null, log });
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: await (deps.authHeader || vertexAuthHeader)(), 'Content-Type': 'application/json' },
      body: JSON.stringify(chatRequestBody(prompt)),
    });
    if (!upstream.ok || !upstream.body) {
      // The status and its enum only: a 400 can quote the prompt back, and it holds the retrieved transcript (Q29).
      const errText = upstream.body ? await responseTextHead(upstream) : '';
      throw vertexRefusal('vertex_stream_failed:', upstream.status, errText);
    }

    const decoder = new TextDecoder();
    let emittedText = false;

    const feeder = createSseLineFeeder((rawLine) => {
      const parsed = parseSseDataLine(rawLine);
      if (parsed.type === 'parse_error') {
        log.warn({ uid, errorName: parsed.errorName, payloadChars: parsed.payloadChars }, 'chat_stream_parse_failed');
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

module.exports = { noteOverview, CHAT_CAP_MESSAGE, handleSearch, handleChatStream, hybridSearch, chatRequestBody, MAX_QUESTION_CHARS, embedQuery, buildChatPrompt, redactHits, parseSseDataLine, createSseLineFeeder };
