// services/db-job/src/index.js — dispatcher for one-shot DB jobs.
//
// Invocation:
//   gcloud run jobs execute db-job --update-env-vars JOB_NAME=verify-phase-0 --wait
//
// Env contract:
//   JOB_NAME       — required. One of the HANDLERS keys below (the deploy
//                    pipeline runs `migrate` before every rollout).
//   MODE           — handler-specific.
//   PGHOST/PGUSER/PGPASSWORD/PGDATABASE — set by --set-env-vars + --set-secrets at deploy time.
//   TRACE_ID       — optional; auto-generated if absent. Mirrors lib/logger.ts contract.

'use strict';

const { randomUUID } = require('node:crypto');

function loadShared(name) {
  // Same dual-path loader pattern as services/transcoder/src/db.js so this
  // works whether `shared/` was copied into the Docker context (production)
  // or symlinked from the repo root (local dev).
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const HANDLERS = {
  'migrate':        () => require('./handlers/migrate.js'),
  'sweep':          () => require('./handlers/sweep.js'),
  'vertex-smoke':   () => require('./handlers/vertex-smoke.js'),
  'verify-phase-0': () => require('./handlers/verify-phase-0.js'),
  'eval-recall':    () => require('./handlers/eval-recall.js'),
  'eval-diarisation': () => require('./handlers/eval-diarisation.js'),
  'debug-corpus':   () => require('./handlers/debug-corpus.js'),
  'grant-tester':   () => require('./handlers/grant-tester.js'),
};

async function main() {
  const jobName = process.env.JOB_NAME;
  const traceId = process.env.TRACE_ID || randomUUID();

  // The shared structured logger (CLAUDE.md §1): Cloud Logging severity +
  // traceId on every line. (It exports `logger`/`makeLogger`; the old
  // `.forContext` call never existed, so every run fell back to a hand-rolled
  // logger with no severity field.)
  const log = loadShared('logger.cjs').logger.child({ traceId, service: 'db-job', jobName });

  if (!jobName) {
    log.error({}, 'job_name_missing');
    process.exitCode = 64;
    return;
  }

  const factory = HANDLERS[jobName];
  if (!factory) {
    log.error({ available: Object.keys(HANDLERS) }, 'job_name_unknown');
    process.exitCode = 64;
    return;
  }

  // Every db-job handler connects to Postgres; fail loudly here rather than let
  // a handler default to a wrong/missing target mid-run.
  const { requireEnv } = loadShared('require-env.cjs');
  requireEnv(
    'db-job',
    {
      exact: { WRITE_POSTGRES: 'true' },
      oneOf: [
        { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      ],
    },
    { logger: log, exit: false },
  );

  log.info({ mode: process.env.MODE || null }, 'job_starting');
  const startMs = Date.now();
  try {
    const handler = factory();
    await handler.run({ log, traceId, env: process.env });
    log.info({ wallMs: Date.now() - startMs }, 'job_succeeded');
  } catch (err) {
    log.error({ err, wallMs: Date.now() - startMs }, 'job_failed');
    process.exitCode = 1;
  }
}

main().catch(err => {
  // Defensive top-level — main() shouldn't throw because of its try/catch,
  // but if it does we still need a non-zero exit.
  process.stdout.write(JSON.stringify({ level: 'error', service: 'db-job', msg: 'main_unhandled', err: err?.message }) + '\n');
  process.exit(2);
});
