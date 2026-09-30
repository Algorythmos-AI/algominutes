#!/usr/bin/env node
// Deploy preflight (RELEASE.md rev 11, H1b): before an image rolls out, check the env the LIVE Cloud Run
// service already has against that image's src/env-spec.cjs. A deploy only swaps the image; env is
// Terraform's. So an image that needs env no apply has set yet fails here, naming the variable, instead of
// crash-looping at rollout (#281: billing needed BILLING_URL, which only Apply B sets).
//
// Usage (in deploy-staging.yml, from a checkout of the commit being deployed):
//   gcloud run services describe <svc> --format=json | node scripts/check-live-env.mjs <svc>
// Exits 1 on a missing required variable. A missing `soft` one is a warning: the service boots without it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { checkEnv } = require(path.join(repo, 'packages', 'ai', 'src', 'require-env.cjs'));

/** What the live container sees: a plain value as itself, a Secret Manager reference as a placeholder. */
export function liveEnv(describe) {
  const env = {};
  for (const e of describe?.spec?.template?.spec?.containers?.[0]?.env || []) {
    env[e.name] = e.valueFrom ? '<secret>' : e.value;
  }
  return env;
}

/** The spec's problems against the live env, split into the ones that stop a rollout and the soft ones. */
export function liveEnvProblems(spec, describe) {
  const { soft = [], ...hard } = spec;
  const env = liveEnv(describe);
  return { hard: checkEnv(hard, env), soft: checkEnv({ soft }, env) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const service = process.argv[2];
  if (!service) {
    process.stderr.write('usage: gcloud run services describe <svc> --format=json | check-live-env.mjs <svc>\n');
    process.exit(2);
  }
  const spec = require(path.join(repo, 'services', service, 'src', 'env-spec.cjs'));
  const { hard, soft } = liveEnvProblems(spec, JSON.parse(fs.readFileSync(0, 'utf8')));
  for (const p of soft) process.stdout.write(`::warning::${service}: ${p} (soft: it boots and logs ${service}_config_missing)\n`);
  if (hard.length) {
    for (const p of hard) process.stdout.write(`::error::${service}: ${p} on the live service; apply the Terraform that sets it, then redeploy\n`);
    process.exit(1);
  }
  process.stdout.write(`check-live-env: ${service} OK\n`);
}
