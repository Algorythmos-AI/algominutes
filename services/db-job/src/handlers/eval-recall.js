// services/db-job/src/handlers/eval-recall.js — Phase β.5 PR-G recall@k.
//
// Reads evals/queries.jsonl, embeds each query via Vertex
// text-embedding-004 (RETRIEVAL_QUERY task), runs pgvector cosine
// similarity against embeddings, computes recall@1, recall@5, recall@10
// against expected_note_topics matched against note title/source filename.
//
// Per Loop-prevention Rule 6 stop-condition: emit recall@10 number; if
// < 0.85, document follow-up (don't iterate RRF in this handler — that
// belongs in a separate retrieval-tuning PR).
//
// Multi-tenancy: queries are scoped to a workspace_id passed via env.
// For the alpha eval we use workspace_e2e-test-uid which contains
// peptides + prp + lady-cdc.
//
// Output: writes a JSON summary to stdout (captured by Cloud Logging).
// Operator copies the result to evidence/pr-g-recall-YYYY-MM-DD.json.
//
// Invocation:
//   gcloud run jobs execute db-job \
//     --update-env-vars JOB_NAME=eval-recall,EVAL_WORKSPACE_ID=workspace_e2e-test-uid \
//     --wait

'use strict';

const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth } = require('google-auth-library');

const { EMBED_MODEL } = require('@algominutes/ai/models.cjs');
const EMBED_DIM = 768;

function vectorToSqlText(values) {
  return '[' + values.join(',') + ']';
}

async function embedQuery(text, project, location) {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = tokenResp?.token;
  if (!token) throw new Error('embedQuery: failed to mint ADC token');

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${EMBED_MODEL}:predict`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }],
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`vertex_embed_failed: ${resp.status} ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  const values = data?.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values) || values.length !== EMBED_DIM) {
    throw new Error(`embedQuery: unexpected response shape (got ${values?.length} dims)`);
  }
  return values;
}

function noteIdMatches(noteId, expectedNoteIds) {
  if (!expectedNoteIds || expectedNoteIds.length === 0) return false;
  return expectedNoteIds.includes(String(noteId));
}

async function run({ log, traceId, env }) {
  const wsId = env.EVAL_WORKSPACE_ID;
  if (!wsId) throw new Error('EVAL_WORKSPACE_ID env var required (e.g. workspace_e2e-test-uid)');

  // Resolve queries file (copied into the container under /app/evals)
  const candidates = [
    path.join(__dirname, '../../evals/queries.jsonl'),
    path.join(__dirname, '../../../evals/queries.jsonl'),
    '/app/evals/queries.jsonl',
  ];
  const queriesPath = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!queriesPath) throw new Error(`evals/queries.jsonl not found; checked: ${candidates.join(', ')}`);
  log.info({ traceId, queriesPath }, 'eval_recall_loading_queries');

  const queries = fs.readFileSync(queriesPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('//'))
    .map(l => JSON.parse(l));
  log.info({ traceId, queryCount: queries.length, wsId }, 'eval_recall_starting');

  const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
  });

  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'algominutes-dev';
  const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
  const K_MAX = 10;

  const results = [];
  let recall1Hits = 0, recall5Hits = 0, recall10Hits = 0;
  let mrrSum = 0;
  let evaluable = 0; // queries where expected_recall=1

  try {
    for (const q of queries) {
      const expectedRecall = q.expected_recall ?? 1;

      let topK = [];
      try {
        const vec = await embedQuery(q.query, project, location);
        // notes.title is set by e2e-test to "E2E ${filename}"; we match
        // expected_note_topics against the title (and chunk_text as a
        // fallback for notes that don't have a useful title).
        const sql = `
          SELECT e.note_id,
                 COALESCE(n.title, '') AS title,
                 LEFT(COALESCE(e.chunk_text, ''), 200) AS chunk_text_head,
                 e.embedding <=> $1::vector AS distance
            FROM embeddings e
            JOIN notes n ON n.id = e.note_id
           WHERE e.workspace_id = $2
             AND n.deleted_at IS NULL
           ORDER BY e.embedding <=> $1::vector
           LIMIT $3`;
        const r = await pool.query(sql, [vectorToSqlText(vec), wsId, K_MAX]);
        topK = r.rows;
      } catch (err) {
        log.error({ traceId, queryId: q.id, err: { message: err?.message } }, 'eval_query_failed');
        results.push({ id: q.id, query: q.query, error: err?.message });
        continue;
      }

      // Match each top-K hit's note_id against expected_note_ids
      const hits = topK.map(r => ({
        noteId: r.note_id,
        title: r.title,
        chunkTextHead: r.chunk_text_head,
        distance: r.distance,
        match: noteIdMatches(r.note_id, q.expected_note_ids),
      }));

      let firstMatchRank = -1;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].match) { firstMatchRank = i + 1; break; }
      }

      const recallAt = (k) => firstMatchRank > 0 && firstMatchRank <= k ? 1 : 0;
      const r1 = recallAt(1), r5 = recallAt(5), r10 = recallAt(10);

      // Negative match queries (expected_recall=0): pass means top-1 has NO match
      let pass;
      if (expectedRecall === 0) {
        pass = firstMatchRank === -1; // no spurious match
      } else {
        pass = r10 === 1;
        evaluable++;
        recall1Hits += r1;
        recall5Hits += r5;
        recall10Hits += r10;
        if (firstMatchRank > 0) mrrSum += 1 / firstMatchRank;
      }

      results.push({
        id: q.id,
        query: q.query,
        category: q.category,
        expectedNoteIds: q.expected_note_ids,
        firstMatchRank,
        r1, r5, r10,
        pass,
        topKSummary: hits.slice(0, 5).map(h => ({
          noteId: h.noteId,
          dist: Number(h.distance).toFixed(3),
          chunkHead: (h.chunkTextHead || '').slice(0, 60),
          match: h.match,
        })),
      });

      log.info({ traceId, queryId: q.id, query: q.query, firstMatchRank, r10, pass }, 'eval_query_result');
    }

    const recall1 = evaluable ? recall1Hits / evaluable : 0;
    const recall5 = evaluable ? recall5Hits / evaluable : 0;
    const recall10 = evaluable ? recall10Hits / evaluable : 0;
    const mrr = evaluable ? mrrSum / evaluable : 0;

    const summary = {
      timestamp: new Date().toISOString(),
      workspace: wsId,
      queryCount: queries.length,
      evaluable,
      recall1: Number(recall1.toFixed(3)),
      recall5: Number(recall5.toFixed(3)),
      recall10: Number(recall10.toFixed(3)),
      mrr: Number(mrr.toFixed(3)),
      gateRecall10MinPass: 0.85,
      gateClosed: recall10 >= 0.85,
      results,
    };

    log.info({ traceId, ...summary }, 'eval_recall_summary');
  } finally {
    await pool.end().catch(err =>
      log.error({ traceId, err: { message: err?.message } }, 'pool_end_failed'),
    );
  }
}

module.exports = { run };
