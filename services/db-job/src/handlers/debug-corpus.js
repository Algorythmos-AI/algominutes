// Quick diagnostic: dump per-note embedding counts + titles for the
// e2e workspace, plus raw similarity for a CJC 1295 query.
'use strict';

const { Pool } = require('pg');
const { GoogleAuth } = require('google-auth-library');

async function embedQuery(text, project, location) {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const t = (await client.getAccessToken())?.token;
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/text-embedding-004:predict`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ task_type: 'RETRIEVAL_QUERY', content: text }] }),
  });
  return (await r.json())?.predictions?.[0]?.embeddings?.values;
}

async function run({ log, traceId, env }) {
  const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  try {
    const { rows: noteCounts } = await pool.query(`
      SELECT n.id, n.title, n.workspace_id, n.status,
             (SELECT count(*) FROM transcript_lines WHERE note_id = n.id) AS line_count,
             (SELECT count(*) FROM embeddings WHERE note_id = n.id) AS chunk_count,
             (SELECT count(DISTINCT workspace_id) FROM embeddings WHERE note_id = n.id) AS distinct_chunk_ws
        FROM notes n
       WHERE n.workspace_id = 'workspace_e2e-test-uid'
       ORDER BY n.created_at DESC
    `);
    for (const r of noteCounts) {
      log.info({ traceId, ...r }, 'note_stats');
    }

    const project = process.env.GCLOUD_PROJECT || 'algominutes-dev';
    const location = process.env.AIPLATFORM_LOCATION || 'us-central1';
    const queries = [
      'CJC 1295 and Ipamorelin peptide stack',
      'BPC-157 dose',
    ];
    for (const q of queries) {
      const vec = await embedQuery(q, project, location);
      const v = '[' + vec.join(',') + ']';
      // Show top 5 globally (no workspace filter) AND top 5 in our workspace
      const { rows: globalTop } = await pool.query(`
        SELECT e.note_id, e.workspace_id, n.title, e.embedding <=> $1::vector AS distance,
               LEFT(e.chunk_text, 80) AS chunk_head
          FROM embeddings e LEFT JOIN notes n ON n.id = e.note_id
         ORDER BY e.embedding <=> $1::vector LIMIT 5`, [v]);
      log.info({ traceId, q, scope: 'global', topK: globalTop }, 'top_k_global');
      const { rows: wsTop } = await pool.query(`
        SELECT e.note_id, e.workspace_id, n.title, e.embedding <=> $1::vector AS distance,
               LEFT(e.chunk_text, 80) AS chunk_head
          FROM embeddings e LEFT JOIN notes n ON n.id = e.note_id
         WHERE e.workspace_id = 'workspace_e2e-test-uid'
         ORDER BY e.embedding <=> $1::vector LIMIT 5`, [v]);
      log.info({ traceId, q, scope: 'workspace_e2e-test-uid', topK: wsTop }, 'top_k_ws');
    }
  } finally {
    await pool.end().catch(err =>
      log.error({ traceId, err: { message: err?.message } }, 'pool_end_failed'),
    );
  }
}
module.exports = { run };
