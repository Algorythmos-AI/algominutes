// services/db-job/src/handlers/verify-phase-0.js — Phase 0 verification queries.
//
// Mirror of evidence/phase-0-queries-studio.sql but executable from a
// Cloud Run Job. Produces JSON-line output (one log entry per query) that
// Cloud Logging captures verbatim — same numbers as the Studio run, with
// audit trail.
//
// Re-runnable: read-only. Safe to invoke any time.

'use strict';

const { Pool } = require('pg');

// Threshold = 02:00 UTC on 2026-05-08, the Phase α deploy time (= 12:00 Sydney).
// Updated 2026-05-08 after we found the v3 plan's 11:30+00 was wrong.
const PHASE_ALPHA_DEPLOY_TS = '2026-05-08 02:00:00+00';

const QUERIES = [
  {
    name: 'A_chunked_redaction',
    description: 'post-Phase-α chunked transcript_lines redaction check',
    sql: `
      SELECT count(*) AS rows_seen,
             count(*) FILTER (WHERE text LIKE '%<<REDACTED%') AS redacted_rows,
             count(*) FILTER (WHERE text ~ '\\m\\d{3}-?\\d{2}-?\\d{4}\\M') AS raw_ssn_shapes,
             count(*) FILTER (WHERE text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}') AS raw_email_shapes
        FROM transcript_lines tl
        JOIN notes n ON n.id = tl.note_id
       WHERE n.created_at > $1`,
    params: [PHASE_ALPHA_DEPLOY_TS],
    pass: (r) => r.raw_ssn_shapes === '0' && r.raw_email_shapes === '0',
  },
  {
    name: 'B_embeddings_pii',
    description: 'embeddings raw-PII check (vacuously passes if rows_seen=0)',
    sql: `
      SELECT count(*) FILTER (WHERE chunk_text ~ '\\m\\d{3}-?\\d{2}-?\\d{4}\\M') AS raw_ssn_in_embeddings,
             count(*) FILTER (WHERE chunk_text ~* '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}') AS raw_email_in_embeddings,
             count(*) AS rows_seen
        FROM embeddings
       WHERE created_at > $1`,
    params: [PHASE_ALPHA_DEPLOY_TS],
    pass: (r) => r.raw_ssn_in_embeddings === '0' && r.raw_email_in_embeddings === '0',
  },
  {
    name: 'C_bug_15_speaker_tag',
    description: 'Bug 15 verification — multi-word lines closure rule',
    // transcript_lines has no created_at column (schema drift from earlier
    // assumption); filter through notes.created_at instead. Same shape as
    // the Studio query the operator validated 2026-05-08.
    sql: `
      SELECT count(*) AS null_speaker_rows,
             COALESCE(avg(length(tl.text))::int, 0) AS avg_text_len,
             COALESCE(max(length(tl.text)), 0) AS max_text_len,
             COALESCE(min(length(tl.text)), 0) AS min_text_len
        FROM transcript_lines tl
        JOIN notes n ON n.id = tl.note_id
       WHERE n.created_at > '2026-04-28'
         AND (tl.speaker_tag IS NULL OR tl.speaker_tag = 0)`,
    params: [],
    pass: (r) => r.null_speaker_rows === '0' || Number(r.avg_text_len) > 30,
  },
  {
    name: 'D_cross_workspace_leakage',
    description: 'multi-tenancy invariant — cross-workspace embedding leakage',
    sql: `
      SELECT count(*) AS overlap_count
        FROM notes n
        JOIN embeddings e ON e.note_id = n.id
       WHERE n.workspace_id IS DISTINCT FROM e.workspace_id`,
    params: [],
    pass: (r) => r.overlap_count === '0',
  },
  {
    name: 'BASELINE_LINES',
    description: 'corpus size for Phase β.3 cost-sizing',
    sql: `
      SELECT count(*) AS total_lines,
             COALESCE(sum(length(text)), 0) AS total_chars,
             (COALESCE(sum(length(text)), 0) / 4)::bigint AS approx_tokens
        FROM transcript_lines`,
    params: [],
    pass: () => true,
  },
  {
    name: 'BASELINE_WORKSPACES',
    description: 'workspace count for Phase β.3 multi-tenancy iteration',
    sql: `SELECT count(*) AS workspace_count FROM workspaces`,
    params: [],
    pass: () => true,
  },
];

async function run({ log, traceId }) {
  const pool = new Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    // Cloud SQL pg_hba.conf requires SSL from the VPC connector network.
    // Mirror services/transcoder/src/db.js:35 which has the same setting.
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
  });

  let allPass = true;
  const results = [];

  try {
    for (const q of QUERIES) {
      const t0 = Date.now();
      const { rows } = await pool.query(q.sql, q.params);
      const row = rows[0] || {};
      const ok = q.pass(row);
      allPass = allPass && ok;
      results.push({ name: q.name, pass: ok, row });
      log.info(
        { traceId, query: q.name, description: q.description, pass: ok, row, wallMs: Date.now() - t0 },
        'verify_query_result'
      );
    }
  } finally {
    await pool.end().catch(err =>
      log.error({ traceId, err: { message: err?.message } }, 'pool_end_failed')
    );
  }

  log.info(
    { traceId, allPass, results: results.map(r => ({ name: r.name, pass: r.pass })) },
    'verify_phase_0_summary'
  );

  if (!allPass) {
    throw new Error('one_or_more_verify_queries_failed');
  }
}

module.exports = { run };
