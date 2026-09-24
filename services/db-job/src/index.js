// services/db-job/src/index.js — dispatcher for one-shot DB jobs.
//
// Invocation:
//   gcloud run jobs execute db-job --update-env-vars JOB_NAME=verify-phase-0 --wait
//
// Env contract:
//   JOB_NAME       — required. One of: verify-phase-0, backfill-pr-d.
//   MODE           — handler-specific. e.g. backfill-pr-d takes dry-run|commit.
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
  'verify-phase-0': () => require('./handlers/verify-phase-0.js'),
  'backfill-pr-d':  () => require('./handlers/backfill-pr-d.js'),
  'eval-recall':    () => require('./handlers/eval-recall.js'),
  'eval-diarisation': () => require('./handlers/eval-diarisation.js'),
  'debug-corpus':   () => require('./handlers/debug-corpus.js'),
};

async function main() {
  const jobName = process.env.JOB_NAME;
  const traceId = process.env.TRACE_ID || randomUUID();

  // Structured log (no console.* per CLAUDE.md §2). The shared logger
  // exists as `shared/logger.cjs`; tolerate it not being copied yet.
  let log;
  try {
    log = loadShared('logger.cjs').forContext({ traceId, service: 'db-job', jobName });
  } catch {
    // Fallback minimal pino-shaped logger so we never crash on logging.
    const emit = (level, obj, msg) => process.stdout.write(JSON.stringify({ level, traceId, service: 'db-job', jobName, ...obj, msg }) + '\n');
    log = { info: (o, m) => emit('info', o, m), warn: (o, m) => emit('warn', o, m), error: (o, m) => emit('error', o, m) };
  }

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
    log.error({ err: { message: err?.message, stack: err?.stack }, wallMs: Date.now() - startMs }, 'job_failed');
    process.exitCode = 1;
  }
}

main().catch(err => {
  // Defensive top-level — main() shouldn't throw because of its try/catch,
  // but if it does we still need a non-zero exit.
  process.stdout.write(JSON.stringify({ level: 'error', service: 'db-job', msg: 'main_unhandled', err: err?.message }) + '\n');
  process.exit(2);
});
