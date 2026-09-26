// services/db-job/src/handlers/migrate.js — apply Postgres migrations from
// inside the VPC (Cloud SQL is private-IP only).
//
// The deploy pipeline runs this BEFORE rolling out any service image:
//   gcloud run jobs execute db-job --wait \
//     --update-env-vars JOB_NAME=migrate,EXPECTED_MIGRATION_HEAD=012_x.sql,TRACE_ID=<uuid>
//
// New migrations are expand-only (or a marked contract step whose old shape no
// serving code uses) — enforced by scripts/check-migration-expand.mjs — so the
// schema can run ahead of the code that is serving, never break it.
// Idempotent and advisory-locked: a Cloud Run Job retry or a re-run deploy
// finds nothing to do.

'use strict';

const { runMigrations } = require('@algominutes/db/migrator');

async function run({ log, env }) {
  // Required, not optional: without it an image built before the deploying
  // commit could report "at head" for a schema the new services don't match.
  if (!env.EXPECTED_MIGRATION_HEAD) {
    throw new Error('EXPECTED_MIGRATION_HEAD is required for JOB_NAME=migrate');
  }
  await runMigrations({
    log,
    expectedHead: env.EXPECTED_MIGRATION_HEAD,
    lockTimeoutMs: env.MIGRATION_LOCK_TIMEOUT_MS ? Number(env.MIGRATION_LOCK_TIMEOUT_MS) : undefined,
  });
}

module.exports = { run };
