'use strict';

// Boot-time environment validation. Fail fast and loud when a service is
// started without the configuration it needs, instead of silently defaulting
// to a wrong value — the "deploy.sh silently defaults unset env vars" trap
// documented in the source's release-protocol runbook. Call once at the very
// top of a service entrypoint, after the logger is loaded and before any
// route/queue wiring.
//
// spec:
//   required: string[]                       // each must be a non-empty string
//   oneOf:    { label: string, of: string[][] }[]
//             // at least one inner group must be fully present, e.g.
//             // { label: 'a Postgres target', of: [['DATABASE_URL'],
//             //   ['PGHOST','PGDATABASE','PGUSER','PGPASSWORD']] }
//   exact:    { [name]: string }
//             // must equal the value exactly, e.g. { WRITE_POSTGRES: 'true' } —
//             // catches a flag that is unset AND one set to the wrong value
//
// On failure it logs a single structured `env_validation_failed` line naming
// every problem, then exits 78 (EX_CONFIG) so the Cloud Run revision is marked
// unhealthy rather than serving with bad config. `exit: false` throws instead
// (used by tests).
function present(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

function requireEnv(service, spec, opts) {
  const { logger, exit = true } = opts || {};
  if (!logger || typeof logger.error !== 'function') {
    throw new Error('requireEnv: a structured logger is required');
  }
  const problems = [];

  for (const name of spec.required || []) {
    if (!present(name)) problems.push(`missing required env ${name}`);
  }

  for (const group of spec.oneOf || []) {
    const satisfied = (group.of || []).some((set) => set.every(present));
    if (!satisfied) {
      const options = (group.of || []).map((set) => set.join('+')).join(' OR ');
      problems.push(`need ${group.label}: one of [${options}]`);
    }
  }

  for (const [name, want] of Object.entries(spec.exact || {})) {
    const got = process.env[name];
    if (got !== want) {
      problems.push(`env ${name} must be '${want}' (got ${got === undefined ? 'unset' : `'${got}'`})`);
    }
  }

  if (problems.length > 0) {
    logger.error({ service, problems }, 'env_validation_failed');
    if (exit) {
      process.exit(78); // EX_CONFIG
    }
    throw new Error(`env_validation_failed for ${service}: ${problems.join('; ')}`);
  }
}

module.exports = { requireEnv };
