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
//   soft:     string[]
//             // config a later Terraform apply sets: checkEnv holds it to the
//             // `required` rule (so the Terraform contract test and a saved plan
//             // must set it), but at boot a missing one is only returned, for the
//             // service to log and to refuse just the work that needs it. An
//             // image merged before its apply then deploys instead of
//             // crash-looping every rollout (RELEASE.md rev 11, H1a).
//
// On failure it logs a single structured `env_validation_failed` line naming
// every problem, then exits 78 (EX_CONFIG) so the Cloud Run revision is marked
// unhealthy rather than serving with bad config. `exit: false` throws instead
// (used by tests).
function present(env, name) {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Every way `env` fails `spec`, as messages; empty when it passes. Pure, so
 * the boot check, the Terraform contract test and the saved-plan check
 * (scripts/check-tfplan-env.mjs) all apply exactly the same rules.
 */
function checkEnv(spec, env) {
  const problems = [];

  for (const name of [...(spec.required || []), ...(spec.soft || [])]) {
    if (!present(env, name)) problems.push(`missing required env ${name}`);
  }

  for (const group of spec.oneOf || []) {
    const satisfied = (group.of || []).some((set) => set.every((name) => present(env, name)));
    if (!satisfied) {
      const options = (group.of || []).map((set) => set.join('+')).join(' OR ');
      problems.push(`need ${group.label}: one of [${options}]`);
    }
  }

  for (const [name, want] of Object.entries(spec.exact || {})) {
    const got = env[name];
    if (got !== want) {
      problems.push(`env ${name} must be '${want}' (got ${got === undefined ? 'unset' : `'${got}'`})`);
    }
  }

  return problems;
}

/**
 * Exits (or throws) on any hard problem; returns the soft names that are
 * missing, for the caller to log as `<service>_config_missing`.
 */
function requireEnv(service, spec, opts) {
  const { logger, exit = true } = opts || {};
  if (!logger || typeof logger.error !== 'function') {
    throw new Error('requireEnv: a structured logger is required');
  }
  const { soft = [], ...hard } = spec || {};
  const problems = checkEnv(hard, process.env);

  if (problems.length > 0) {
    logger.error({ service, problems }, 'env_validation_failed');
    if (exit) {
      process.exit(78); // EX_CONFIG
    }
    throw new Error(`env_validation_failed for ${service}: ${problems.join('; ')}`);
  }
  return soft.filter((name) => !present(process.env, name));
}

module.exports = { requireEnv, checkEnv };
