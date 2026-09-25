import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  ENVS, MODULE, read, stripComments, mapBody, entries, mergeParts, resolve, balanced, type Env, type Resolved,
} from './helpers/terraform';

// Every service refuses to boot without the env in its src/env-spec.cjs
// (require-env.cjs exits 78). The staging plan of 2026-09-25 gave the api
// ALLOWED_ORIGINS="" (a module default nothing overrode), so the first deploy
// would have crashed the api, and nothing caught it: CI's boot smoke supplies
// its own fake env. This test reads the env Terraform actually gives each
// service and job, in every environment, and checks it against the spec.
const require = createRequire(import.meta.url);

type Spec = {
  required?: string[];
  exact?: Record<string, string>;
  oneOf?: { label: string; of: string[][] }[];
};
const spec = (svc: string): Spec => require(`../services/${svc}/src/env-spec.cjs`);
const { checkEnv } = require('@algominutes/ai/require-env.cjs') as { checkEnv: (s: Spec, e: Record<string, string | undefined>) => string[] };

const cloudRun = read(`${MODULE}/cloud-run.tf`);
const scheduler = read(`${MODULE}/scheduler.tf`);
const locals = stripComments(cloudRun);

/** A map expression's entries: a `{...}` literal, or a `local.X` map. */
function mapOf(expr: string): Record<string, string> {
  const e = expr.trim();
  if (e.startsWith('{')) return entries(e.slice(1, -1));
  const local = /^local\.(\w+)$/.exec(e);
  if (local) {
    // A conditional local (e.g. admin_env) contributes nothing guaranteed.
    const decl = new RegExp(`\\n\\s*${local[1]}\\s*=\\s*(.+)`).exec(locals);
    if (decl && /\?/.test(decl[1]) && !decl[1].trim().startsWith('{')) return {};
    return entries(mapBody(locals, local[1]));
  }
  throw new Error(`can't read map expression ${e}`);
}

function envFrom(expr: string): Record<string, string> {
  return Object.assign({}, ...mergeParts(expr).map(mapOf));
}

const common = envFrom('local.common_env');
const serviceEnv = entries(mapBody(locals, 'service_env'));
const dbServices = JSON.parse(/db_services\s*=\s*(\[[^\]]*\])/.exec(locals)![1]) as string[];

/** The `resource "google_cloud_run_v2_service" "services"` block. */
const servicesResource = (() => {
  const at = locals.indexOf('resource "google_cloud_run_v2_service" "services"');
  if (at < 0) throw new Error('no google_cloud_run_v2_service.services');
  return balanced(locals, locals.indexOf('{', at));
})();

/**
 * The DB services' extra env, only as far as the resource really sets it: the
 * PG_POOL_MAX merge and the dynamic PGPASSWORD block from Secret Manager.
 */
const dbExtras = {
  PG_POOL_MAX: /contains\(local\.db_services,\s*each\.key\)\s*\?\s*\{\s*PG_POOL_MAX\s*=/.test(servicesResource),
  PGPASSWORD: /dynamic\s+"env"\s*\{\s*for_each\s*=\s*contains\(local\.db_services,\s*each\.key\)\s*\?\s*\[1\]\s*:\s*\[\]\s*content\s*\{\s*name\s*=\s*"PGPASSWORD"\s*value_source\s*\{\s*secret_key_ref/.test(servicesResource),
};

/** Everything a Cloud Run service's container gets, name → expression. */
function envOfService(svc: string): Record<string, string> {
  if (!(svc in serviceEnv)) throw new Error(`service_env has no entry for ${svc}`);
  const env = { ...common, ...envFrom(serviceEnv[svc]) };
  if (dbServices.includes(svc)) {
    if (dbExtras.PG_POOL_MAX) env.PG_POOL_MAX = 'local.connection_budget'; // tostring(var.connection_budget...pool_max): a number
    if (dbExtras.PGPASSWORD) env.PGPASSWORD = 'google_secret_manager_secret.db_password'; // secret_key_ref
  }
  return env;
}

/** A Cloud Run job's env, from its `for_each = merge(...)` block (+ PGPASSWORD). */
function envOfJob(src: string, resource: string): Record<string, string> {
  const at = src.indexOf(`resource "google_cloud_run_v2_job" "${resource}"`);
  expect(at, `no job ${resource}`).toBeGreaterThanOrEqual(0);
  const body = stripComments(src.slice(at));
  const fe = /for_each\s*=\s*merge\(/.exec(body)!;
  const expr = `merge(${balanced(body, fe.index + fe[0].length - 1)})`;
  const env: Record<string, string> = {};
  for (const part of mergeParts(expr)) {
    Object.assign(env, part.startsWith('{') ? entries(part.slice(1, -1)) : mapOf(part));
  }
  // Values like tostring(var.connection_budget.jobs[...].pool_max) are numbers.
  for (const [k, v] of Object.entries(env)) if (/var\.connection_budget/.test(v)) env[k] = 'local.connection_budget';
  expect(body.slice(0, body.indexOf('lifecycle'))).toMatch(/name\s*=\s*"PGPASSWORD"/);
  env.PGPASSWORD = 'google_secret_manager_secret.db_password';
  return env;
}

const services = Object.keys(serviceEnv);
const targets: { name: string; specOf: string; env: () => Record<string, string> }[] = [
  ...services.map((s) => ({ name: s, specOf: s, env: () => envOfService(s) })),
  { name: 'db-job (job)', specOf: 'db-job', env: () => envOfJob(cloudRun, 'db_job') },
  { name: 'db-sweep (job)', specOf: 'db-job', env: () => envOfJob(scheduler, 'db_sweep') },
];

const show = (r: Resolved) => (r.kind === 'literal' ? JSON.stringify(r.value) : r.kind === 'missing' ? `missing (${r.why})` : 'computed');

describe.each(ENVS)('%s: Terraform sets every env a service requires', (env: Env) => {
  it('covers every service with an env-spec.cjs', () => {
    expect(services.sort()).toEqual(['api', 'billing', 'embedder', 'extractor', 'notifier', 'summarizer', 'transcoder']);
  });

  it.each(targets)('$name', ({ specOf, env: envOf }) => {
    const got = envOf();
    // What the container would see: a literal as itself, a computed value or a
    // secret as a placeholder (never blank), a variable nothing sets as unset.
    const seen: Record<string, string | undefined> = {};
    const unresolved: string[] = [];
    for (const [name, expr] of Object.entries(got)) {
      const r = resolve(expr, env);
      if (r.kind === 'literal') seen[name] = r.value;
      else if (r.kind === 'computed') seen[name] = '<computed>';
      else unresolved.push(`${name}: ${show(r)}`);
    }
    // The same rules the service applies at boot (require-env.cjs).
    const problems = checkEnv(spec(specOf), seen);
    expect({ problems, unresolved: problems.length ? unresolved : [] }).toEqual({ problems: [], unresolved: [] });
  });
});

describe('the api env', () => {
  it('carries the broadcast kill switch', () => {
    expect(envOfService('api')).toMatchObject({ BROADCAST_CAPTURE: 'var.broadcast_capture' });
  });

  it.each(ENVS)('%s: gives the api a real CORS origin', (env) => {
    const r = resolve(envOfService('api').ALLOWED_ORIGINS, env);
    expect(r.kind).toBe('literal');
    expect((r as { value: string }).value).toMatch(/^https:\/\/[^,\s]+(,https:\/\/[^,\s]+)*$/);
  });
});
