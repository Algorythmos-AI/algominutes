#!/usr/bin/env node
// Checks a saved Terraform plan before anyone applies it:
//   * every Cloud Run service and job gets each env var its src/env-spec.cjs
//     requires, non-blank (an unknown-until-apply value counts as set);
//   * the public services (api, billing) skip the invoker IAM check, and no
//     other service does;
//   * nothing binds a role to allUsers or allAuthenticatedUsers (the
//     organization's iam.allowedPolicyMemberDomains policy fails such an apply).
//
// Usage (in infra/terraform/envs/<env>):
//   terraform show -json reviewed-<sha>.tfplan > /tmp/plan.json
//   node ../../../../scripts/check-tfplan-env.mjs /tmp/plan.json
// Exits 1 and lists every problem, or prints a one-line OK.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const planPath = process.argv[2];
if (!planPath) {
  process.stderr.write('usage: check-tfplan-env.mjs <terraform show -json output>\n');
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

const PUBLIC = new Set(['api', 'billing']);
// Which env spec a job runs under: both jobs run the db-job image.
const specFor = (kind, name) => (kind === 'job' ? 'db-job' : name);
const spec = (svc) => require(path.join(repo, 'services', svc, 'src', 'env-spec.cjs'));
const { checkEnv } = require(path.join(repo, 'packages', 'ai', 'src', 'require-env.cjs'));

const problems = [];
let checked = 0;

for (const rc of plan.resource_changes || []) {
  const after = rc.change && rc.change.after;
  if (!after) continue; // a delete: nothing will run
  const unknown = rc.change.after_unknown || {};

  if (rc.type === 'google_cloud_run_v2_service' || rc.type === 'google_cloud_run_v2_job') {
    const kind = rc.type.endsWith('_job') ? 'job' : 'service';
    const name = after.name;
    const tmpl = kind === 'job' ? after.template?.[0]?.template?.[0] : after.template?.[0];
    const tmplUnknown = kind === 'job' ? unknown.template?.[0]?.template?.[0] : unknown.template?.[0];
    const envList = tmpl?.containers?.[0]?.env || [];
    const envUnknown = tmplUnknown?.containers?.[0]?.env || [];
    // What the container would see: a known value as itself; a value known
    // only at apply, or one read from Secret Manager, as a placeholder.
    const seen = {};
    envList.forEach((e, i) => {
      const isUnknown = envUnknown[i] && envUnknown[i].value === true;
      const fromSecret = Array.isArray(e.value_source) && e.value_source.length > 0;
      seen[e.name] = isUnknown || fromSecret ? '<set at apply>' : e.value;
    });
    // The same rules the service applies at boot (require-env.cjs).
    for (const p of checkEnv(spec(specFor(kind, name)), seen)) problems.push(`${kind} ${name}: ${p}`);
    if (kind === 'service') {
      const disabled = after.invoker_iam_disabled === true;
      if (PUBLIC.has(name) && !disabled) problems.push(`service ${name}: public, but the invoker IAM check is on (invoker_iam_disabled)`);
      if (!PUBLIC.has(name) && disabled) problems.push(`service ${name}: private, but the invoker IAM check is off`);
    }
    checked++;
  }

  const members = [after.member, ...(after.members || [])].filter(Boolean);
  for (const m of members) {
    if (m === 'allUsers' || m === 'allAuthenticatedUsers') problems.push(`${rc.address}: binds ${m}, which the org policy refuses`);
  }
}

if (checked === 0) problems.push('no Cloud Run services or jobs in this plan: is it the right file?');

if (problems.length) {
  process.stderr.write(`check-tfplan-env: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`check-tfplan-env: OK (${checked} services and jobs)\n`);
